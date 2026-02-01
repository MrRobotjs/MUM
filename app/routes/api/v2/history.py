from __future__ import annotations

from datetime import datetime
from typing import List, Optional
from uuid import uuid4

from flask import jsonify
from flask_openapi3 import Tag
from pydantic import BaseModel, Field

from app.routes.api.v2 import api_v2
from app.utils.jwt_decorators import jwt_required_with_user


history_tag = Tag(name="History", description="Activity history endpoints")


class HistoryQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)


class HistoryItem(BaseModel):
    id: int
    timestamp: Optional[str] = None
    event_type: Optional[str] = None
    message: Optional[str] = None
    details: dict = {}


class PaginationMeta(BaseModel):
    page: int
    page_size: int
    total_items: int
    total_pages: int


class MetaModel(BaseModel):
    request_id: str
    generated_at: str
    deprecated: bool
    pagination: PaginationMeta
    filters: dict


class HistoryListResponse(BaseModel):
    data: List[HistoryItem]
    meta: MetaModel


@api_v2.get(
    "/history/recent",
    tags=[history_tag],
    summary="Recent history logs",
    responses={200: HistoryListResponse},
)
@jwt_required_with_user()
def list_recent_history(query: HistoryQuery, current_user):
    request_id = uuid4().hex
    page = query.page
    size = query.page_size

    response = {
        "data": [],
        "meta": {
            "request_id": request_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "deprecated": False,
            "pagination": {
                "page": page,
                "page_size": size,
                "total_items": 0,
                "total_pages": 1,
            },
            "filters": {},
        },
    }
    return jsonify(response), 200
