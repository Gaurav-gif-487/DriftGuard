from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List

app = FastAPI()


class Item(BaseModel):
    id: int
    name: str
    price: float
    tags: List[str]
    description: Optional[str] = None


@app.get("/api/v1/inventory/{item_id}")
def get_item(item_id: int) -> Item:
    return {"id": item_id, "name": "Widget", "price": 9.99, "tags": ["new"]}
