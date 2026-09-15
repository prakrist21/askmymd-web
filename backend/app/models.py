"""Pydantic request/response schemas."""

from pydantic import BaseModel, Field


class PrepareRequest(BaseModel):
    # No min_length: an empty string must reach the router so it gets the
    # semantic 400 EMPTY_DOCUMENT instead of a generic validation error.
    markdown_content: str


class PrepareResponse(BaseModel):
    ready: bool


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    question: str = Field(min_length=1)
    chat_history: list[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    answer: str


class CreateDocumentRequest(BaseModel):
    """POST /documents body — content is the markdown document."""

    content: str = Field(min_length=1, max_length=50000)
    title: str | None = Field(default=None, max_length=200)
