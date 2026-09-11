"""Groq LLM calls (summary generation for /prepare, chat answers for /chat,
plus the Phase 5 grading / query-rewrite / grounding-verification calls).

The model name is centralized here so it can be changed in one place.
"""

import logging
import os

from dotenv import load_dotenv
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_groq import ChatGroq

from app.errors import llm_unavailable
from app.models import ChatMessage

load_dotenv()

logger = logging.getLogger("askmymd.llm")

MODEL_NAME = "openai/gpt-oss-120b"

_llm: ChatGroq | None = None


def _get_llm() -> ChatGroq:
    """Lazy singleton so importing this module never fails without a key."""
    global _llm
    if _llm is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key or api_key.startswith("your_"):
            raise llm_unavailable("configure the LLM")
        _llm = ChatGroq(api_key=api_key, model=MODEL_NAME)
    return _llm


_SUMMARY_SYSTEM_PROMPT = (
    "You summarize documents. Summarize the following document in 5-8 "
    "sentences. Capture the main topic, key points, and any conclusions. "
    "Respond with the summary text only."
)

_GRADE_SYSTEM_PROMPT = (
    "You grade whether retrieved document chunks are relevant for answering "
    "a question about a document. You are given a document summary, the "
    "question, and the retrieved chunks. Consider the relevance of the "
    "chunks both to the question and to the document's overall topic. "
    "Respond with exactly one word: 'yes' if the chunks are relevant, "
    "'no' otherwise. No other output."
)

_REWRITE_SYSTEM_PROMPT = (
    "You rewrite search queries for a vector database. You are given the "
    "document summary, the chat history, and the user's question. Produce "
    "a better search query for retrieving the parts of the document that "
    "answer the question: resolve pronouns and vague references from the "
    "history, drop filler words, and include the document's key terms. "
    "Respond with the rewritten query text only, on a single line."
)

_GROUNDED_SYSTEM_PROMPT = (
    "You verify that an answer is grounded in the source material. You are "
    "given a document summary, retrieved chunks, and a draft answer. If "
    "every claim in the answer is supported by the material, respond with "
    "exactly one word: 'yes'. If any claim is unsupported or invented, "
    "respond with exactly one word: 'no'. No other output."
)


def _yes_no(system_prompt: str, user_prompt: str, context: str) -> bool:
    """Shared yes/no LLM judgement used by grading and grounding checks."""
    try:
        response = _get_llm().invoke(
            [SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)]
        )
    except Exception as exc:  # network, auth, rate-limit, timeout...
        logger.warning("%s failed: %s", context, exc)
        raise llm_unavailable(context) from exc

    verdict = str(getattr(response, "content", "") or "").strip().lower()
    if verdict not in ("yes", "no"):
        logger.warning("%s returned unparsable content %r", context, verdict[:120])
        raise llm_unavailable(context)
    return verdict == "yes"


def grade_chunks(question: str, summary: str, chunks: list[str]) -> bool:
    """One Groq call: are the retrieved chunks relevant to question + summary?"""
    prompt = (
        f"<summary>\n{summary}\n</summary>\n\n"
        f"<question>\n{question}\n</question>\n\n"
        + "\n\n".join(f"<chunk>\n{c}\n</chunk>" for c in chunks)
    )
    return _yes_no(_GRADE_SYSTEM_PROMPT, user_prompt=prompt, context="grade chunks")


def rewrite_query(question: str, chat_history: list[ChatMessage], summary: str) -> str:
    """One Groq call: produce a better retrieval query for the question."""
    history = "\n".join(f"{m.role}: {m.content}" for m in chat_history) or "(none)"
    prompt = (
        f"<summary>\n{summary}\n</summary>\n\n"
        f"<chat_history>\n{history}\n</chat_history>\n\n"
        f"<question>\n{question}\n</question>"
    )
    try:
        response = _get_llm().invoke(
            [SystemMessage(content=_REWRITE_SYSTEM_PROMPT), HumanMessage(content=prompt)]
        )
    except Exception as exc:  # network, auth, rate-limit, timeout...
        logger.warning("Query rewrite failed: %s", exc)
        raise llm_unavailable("rewrite query") from exc

    query = str(getattr(response, "content", "") or "").strip()
    if not query:
        logger.warning("Query rewrite returned empty content")
        raise llm_unavailable("rewrite query")
    # Keep it a search query: collapse newlines/extra spaces to single ones.
    query = " ".join(query.split())
    logger.info("Rewritten query: %r", query[:120])
    return query


def verify_grounded(answer: str, retrieved_chunks: list[str], summary: str) -> bool:
    """One Groq call: is every claim in the answer supported by the material?"""
    prompt = (
        f"<summary>\n{summary}\n</summary>\n\n"
        + "\n\n".join(f"<chunk>\n{c}\n</chunk>" for c in retrieved_chunks)
        + f"\n\n<answer>\n{answer}\n</answer>"
    )
    return _yes_no(_GROUNDED_SYSTEM_PROMPT, user_prompt=prompt, context="verify grounding")


def generate_summary(markdown_content: str) -> str:
    """One Groq call producing a short summary of the document."""
    prompt = (
        f"{_SUMMARY_SYSTEM_PROMPT}\n\n"
        f"<document>\n{markdown_content}\n</document>"
    )
    try:
        response = _get_llm().invoke(prompt)
    except Exception as exc:  # network, auth, rate-limit, timeout...
        logger.warning("Summary generation failed: %s", exc)
        raise llm_unavailable("generate summary") from exc

    summary = getattr(response, "content", None)
    if not summary or not str(summary).strip():
        logger.warning("Summary generation returned empty content")
        raise llm_unavailable("generate summary")
    return str(summary).strip()


_ANSWER_SYSTEM_PROMPT = (
    "You answer questions strictly based on the document provided in the "
    "conversation. You are given a document summary and retrieved chunks "
    "from the document. If the answer is not contained in that material, "
    "say that the document does not cover it — never invent information. "
    "Answer in plain text only; do not use markdown formatting."
)

_UNANSWERABLE_SUFFIX = (
    "\n\nIMPORTANT: The retrieved material does not appear to contain the "
    "information needed to answer this question. If you still cannot find "
    "the answer in the material, state clearly that the document does not "
    "cover it — do not guess or invent anything."
)


def generate_answer(
    question: str,
    chat_history: list[ChatMessage],
    retrieved_chunks: list[str],
    summary: str,
    unanswerable_hint: bool = False,
) -> str:
    """One Groq call: summary + top-k chunks + chat history + question.

    `unanswerable_hint` strengthens the anti-hallucination instruction for
    the corrective flow's final attempt after a rewritten query still failed
    to find relevant material.
    """
    context = "\n\n".join(
        [f"<summary>\n{summary}\n</summary>"]
        + [f"<chunk>\n{chunk}\n</chunk>" for chunk in retrieved_chunks]
    )
    messages: list = [SystemMessage(content=_ANSWER_SYSTEM_PROMPT)]
    for msg in chat_history:
        if msg.role == "assistant":
            messages.append(AIMessage(content=msg.content))
        else:
            messages.append(HumanMessage(content=msg.content))
    messages.append(
        HumanMessage(
            content=(
                f"Document material:\n\n{context}\n\n"
                f"Question: {question}"
                + (_UNANSWERABLE_SUFFIX if unanswerable_hint else "")
            )
        )
    )
    try:
        response = _get_llm().invoke(messages)
    except Exception as exc:  # network, auth, rate-limit, timeout...
        logger.warning("Answer generation failed: %s", exc)
        raise llm_unavailable("generate answer") from exc

    answer = getattr(response, "content", None)
    if not answer or not str(answer).strip():
        logger.warning("Answer generation returned empty content")
        raise llm_unavailable("generate answer")
    return str(answer).strip()
