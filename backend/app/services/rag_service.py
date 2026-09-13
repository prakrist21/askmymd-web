"""RAG backend: markdown chunking, FAISS vector store, retrieval, and the
LangGraph corrective-RAG flow used by /chat.

Phase 3 scope: chunk + embed into an in-memory FAISS index held in module
state (single active document, no session id). Phase 5 layers the LangGraph
corrective-RAG flow on top of `retrieve()`.
"""

import logging
import re
from typing import TypedDict

import faiss
import numpy as np
from langgraph.graph import END, START, StateGraph
from sentence_transformers import SentenceTransformer

from app.models import ChatMessage
from app.services import llm_service

logger = logging.getLogger("askmymd.rag")

CHUNK_SIZE = 1000  # characters per chunk (~150-200 words)
CHUNK_OVERLAP = 150  # character overlap between consecutive chunks
TOP_K = 5
MODEL_NAME = "all-MiniLM-L6-v2"

_embedder: SentenceTransformer | None = None


def _get_embedder() -> SentenceTransformer:
    """Lazy singleton — keeps startup fast and import-time side effects zero."""
    global _embedder
    if _embedder is None:
        _embedder = SentenceTransformer(MODEL_NAME)
    return _embedder


def chunk_markdown(content: str) -> list[str]:
    """Split markdown into overlapping character-window chunks.

    Splits on blank lines first so paragraphs stay intact where possible;
    oversized paragraphs are hard-split with overlap.
    """
    content = content.strip()
    if not content:
        return []

    paragraphs = re.split(r"\n\s*\n", content)
    chunks: list[str] = []
    current = ""

    def flush() -> None:
        nonlocal current
        if current.strip():
            chunks.append(current.strip())
        current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        # Hard-split paragraphs that alone exceed the chunk size.
        while len(para) > CHUNK_SIZE:
            flush()
            chunks.append(para[:CHUNK_SIZE].strip())
            para = para[CHUNK_SIZE - CHUNK_OVERLAP :]
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) <= CHUNK_SIZE:
            current = candidate
        else:
            flush()
            current = para
    flush()
    return chunks


class RagStore:
    """In-memory FAISS store for the single active document."""

    def __init__(self) -> None:
        self.index: faiss.Index | None = None
        self.chunks: list[str] = []
        self.summary: str = ""

    def build(self, chunks: list[str], summary: str) -> int:
        """Embed chunks into a fresh FAISS index. Returns the chunk count."""
        if not chunks:
            raise ValueError("cannot build a store from zero chunks")
        vectors = _get_embedder().encode(
            chunks, batch_size=32, show_progress_bar=False, normalize_embeddings=True
        )
        matrix = np.asarray(vectors, dtype="float32")
        index = faiss.IndexFlatIP(matrix.shape[1])  # cosine sim via inner product
        index.add(matrix)
        self.index = index
        self.chunks = list(chunks)
        self.summary = summary
        logger.info("FAISS store built: %d chunks, dim %d", len(chunks), matrix.shape[1])
        return len(self.chunks)

    def retrieve(self, query: str, k: int = TOP_K) -> list[str]:
        """Return the top-k chunks most similar to the query."""
        if self.index is None or not self.chunks:
            raise ValueError("store is empty — call /prepare first")
        query_vec = np.asarray(
            _get_embedder().encode([query], show_progress_bar=False, normalize_embeddings=True),
            dtype="float32",
        )
        scores, ids = self.index.search(query_vec, min(k, len(self.chunks)))
        return [self.chunks[i] for i in ids[0] if 0 <= i < len(self.chunks)]


# Single active document for the whole app (v1: no session ids).
store = RagStore()


# --- LangGraph corrective-RAG flow (Phase 5) -------------------------------

MAX_CORRECTIONS = 1  # one rewrite + re-retrieve round at most


class ChatState(TypedDict):
    """State passed between corrective-RAG graph nodes."""

    question: str
    chat_history: list  # list[ChatMessage] (role/content), resent by frontend
    summary: str
    query: str  # query actually used for retrieval (original or rewritten)
    chunks: list[str]
    grade: str  # "relevant" | "irrelevant"
    corrections: int
    answer: str


def _grade_step(state: ChatState) -> dict:
    """LLM-graded relevance of the retrieved chunks to question + summary."""
    relevant = llm_service.grade_chunks(
        state["question"], state["summary"], state["chunks"]
    )
    grade = "relevant" if relevant else "irrelevant"
    logger.info("Grade: %s (corrections so far: %d)", grade, state["corrections"])
    return {"grade": grade}


def _grade_router(state: ChatState) -> str:
    """After grading: generate if relevant, else rewrite (or give up)."""
    if state["grade"] == "relevant":
        return "generate"
    if state["corrections"] >= MAX_CORRECTIONS:
        return "generate"  # generate with unanswerable hint; verifier guards it
    return "rewrite"


def _generate_step(state: ChatState) -> dict:
    """Draft the answer. After a failed correction round, add the
    unanswerable hint so the model declines rather than invents."""
    hinted = state["corrections"] >= MAX_CORRECTIONS and state["grade"] == "irrelevant"
    answer = llm_service.generate_answer(
        state["question"],
        state["chat_history"],
        state["chunks"],
        state["summary"],
        unanswerable_hint=hinted,
    )
    logger.info("Generate: draft answer (%d chars, hint=%s)", len(answer), hinted)
    return {"answer": answer}


def _verify_step(state: ChatState) -> dict:
    """Verify the draft is grounded in the retrieved material.

    If the verifier rejects the draft, regenerate once with the
    unanswerable hint — the safe fallback is a refusal, not a guess.
    """
    grounded = llm_service.verify_grounded(
        state["answer"], state["chunks"], state["summary"]
    )
    logger.info("Verify: grounded=%s", grounded)
    if grounded:
        return {"answer": state["answer"]}
    fallback = llm_service.generate_answer(
        state["question"],
        state["chat_history"],
        state["chunks"],
        state["summary"],
        unanswerable_hint=True,
    )
    return {"answer": fallback}


def _build_chat_graph(active_store: RagStore) -> object:
    """retrieve -> grade -> (rewrite -> retrieve -> grade) -> generate -> verify.

    The graph closes over *active_store* instead of the module-global ``store``,
    so callers can thread a per-document RagStore through the retrieval nodes.
    Used by v1 /prepare + /chat (global in-memory FAISS). Stage 5 document
    retrieval uses _build_chat_graph_for_document (pgvector) instead.
    """

    def _retrieve_step(state: ChatState) -> dict:
        """Retrieve top-5 chunks from the caller-provided store."""
        chunks = active_store.retrieve(state["query"])
        logger.info("Retrieve: %d chunks for query %r", len(chunks), state["query"][:80])
        return {"chunks": chunks}

    def _rewrite_step(state: ChatState) -> dict:
        """Rewrite the query (history-aware) and re-retrieve with a bigger pool."""
        query = llm_service.rewrite_query(
            state["question"], state["chat_history"], state["summary"]
        )
        logger.info(
            "Correction round %d: re-retrieving with rewritten query",
            state["corrections"] + 1,
        )
        return {
            "query": query,
            "chunks": active_store.retrieve(query, k=TOP_K + 2),
            "corrections": state["corrections"] + 1,
        }

    builder = StateGraph(ChatState)
    builder.add_node("retrieve", _retrieve_step)
    builder.add_node("grade", _grade_step)
    builder.add_node("rewrite", _rewrite_step)
    builder.add_node("generate", _generate_step)
    builder.add_node("verify", _verify_step)

    builder.add_edge(START, "retrieve")
    builder.add_edge("retrieve", "grade")
    builder.add_conditional_edges(
        "grade",
        _grade_router,
        {"rewrite": "rewrite", "generate": "generate"},
    )
    builder.add_edge("rewrite", "retrieve")
    builder.add_edge("generate", "verify")
    builder.add_edge("verify", END)
    return builder.compile()


def _build_chat_graph_for_document(document_id: str) -> object:
    """Stage 5: pgvector retrieval filtered by document_id.

    Replaces the FAISS store closure. ``_retrieve_step`` now does
    ``SELECT content FROM chunks WHERE document_id=:id ORDER BY embedding <=> :query_vec LIMIT k``
    so isolation is enforced by SQL, not by which RagStore object is passed.
    k=5 normally, k=7 (TOP_K+2) for the rewrite path (both the rewrite's
    immediate fetch and the following retrieve after rewrite).
    """

    def _retrieve_step(state: ChatState) -> dict:
        from app.db import search_chunks

        k = TOP_K + 2 if state["corrections"] > 0 else TOP_K
        chunks = search_chunks(document_id, state["query"], k=k)
        logger.info("Retrieve (pgvector): %d chunks (k=%d) for doc %s query %r", len(chunks), k, document_id, state["query"][:80])
        return {"chunks": chunks}

    def _rewrite_step(state: ChatState) -> dict:
        from app.db import search_chunks

        query = llm_service.rewrite_query(
            state["question"], state["chat_history"], state["summary"]
        )
        logger.info(
            "Correction round %d: pgvector re-retrieving with rewritten query for doc %s",
            state["corrections"] + 1,
            document_id,
        )
        return {
            "query": query,
            "chunks": search_chunks(document_id, query, k=TOP_K + 2),
            "corrections": state["corrections"] + 1,
        }

    builder = StateGraph(ChatState)
    builder.add_node("retrieve", _retrieve_step)
    builder.add_node("grade", _grade_step)
    builder.add_node("rewrite", _rewrite_step)
    builder.add_node("generate", _generate_step)
    builder.add_node("verify", _verify_step)

    builder.add_edge(START, "retrieve")
    builder.add_edge("retrieve", "grade")
    builder.add_conditional_edges(
        "grade",
        _grade_router,
        {"rewrite": "rewrite", "generate": "generate"},
    )
    builder.add_edge("rewrite", "retrieve")
    builder.add_edge("generate", "verify")
    builder.add_edge("verify", END)
    return builder.compile()


def run_corrective_rag(
    question: str,
    chat_history: list[ChatMessage],
    summary: str,
    store: RagStore | None = None,
    document_id: str | None = None,
) -> str:
    """Run the corrective-RAG graph for one chat call and return the answer.

    If ``document_id`` is given (Stage 5 /documents ask), retrieval uses
    pgvector filtered by that id (no RagStore, no FAISS). Otherwise falls
    back to the RagStore path (v1 /prepare + /chat and legacy callers).
    """
    if document_id is not None:
        graph = _build_chat_graph_for_document(document_id)
    else:
        effective_store: RagStore = store if store is not None else globals()["store"]  # fallback for legacy callers
        graph = _build_chat_graph(effective_store)

    initial: ChatState = {
        "question": question,
        "chat_history": list(chat_history),
        "summary": summary,
        "query": question,
        "chunks": [],
        "grade": "irrelevant",
        "corrections": 0,
    }
    result = graph.invoke(initial)
    return result["answer"]
