"""In-memory persistence for documents and chat messages.

This module mimics a minimal DB + Chroma collection for the resync feature
without introducing a real external dependency. All state lives in module-level
dicts that can be cleared between tests.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Dict, List

@dataclass
class Document:
    id: str
    owner_id: str
    content: str
    status: str = "ready"  # ready | resyncing | error

@dataclass
class ChatMessageRow:
    id: str
    document_id: str
    owner_id: str
    role: str  # user | assistant
    content: str
    is_archived: bool = False

# Global stores — importable for tests and routers.
documents: Dict[str, Document] = {}
chat_messages: List[ChatMessageRow] = []

# Maps document_id -> its vector chunks (simulates Chroma collection entries)
# In the real Chroma implementation this would be collection.delete(where=...) etc.
chroma_store: Dict[str, List[str]] = {}

def clear_all() -> None:
    """Clear all in-memory state — used by tests."""
    documents.clear()
    chat_messages.clear()
    chroma_store.clear()

def create_document(owner_id: str, content: str, status: str = "ready") -> Document:
    doc_id = str(uuid.uuid4())
    doc = Document(id=doc_id, owner_id=owner_id, content=content, status=status)
    documents[doc_id] = doc
    return doc

def add_chat_message(document_id: str, owner_id: str, role: str, content: str, is_archived: bool = False) -> ChatMessageRow:
    row = ChatMessageRow(
        id=str(uuid.uuid4()),
        document_id=document_id,
        owner_id=owner_id,
        role=role,
        content=content,
        is_archived=is_archived,
    )
    chat_messages.append(row)
    return row

def get_messages_for_document(document_id: str, include_archived: bool = False) -> List[ChatMessageRow]:
    if include_archived:
        return [m for m in chat_messages if m.document_id == document_id]
    return [m for m in chat_messages if m.document_id == document_id and not m.is_archived]

def archive_messages(document_id: str) -> int:
    count = 0
    for m in chat_messages:
        if m.document_id == document_id and not m.is_archived:
            m.is_archived = True
            count += 1
    return count
