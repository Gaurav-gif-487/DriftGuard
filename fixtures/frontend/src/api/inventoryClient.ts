export interface InventoryItem {
  id: number;
  name: string;
  price: number;
  tags: string[];
  sku: string;
}

/**
 * Calls the FastAPI inventory route (fixtures/backend/src/inventory_service.py).
 * DRIFTED: the client contract requires `sku`, which the Pydantic `Item`
 * model never returns, and expects `tags` to be present (it is), but the
 * server's `get_item` handler builds its dict literal without one — this
 * is intentional seeded drift so the Python parsing path (Pydantic
 * return-type resolution) has something real to catch end-to-end, not
 * just in unit tests.
 */
export async function getInventoryItem(id: string): Promise<InventoryItem> {
  const data: InventoryItem = await fetch(`/api/v1/inventory/${id}`).then((r) => r.json());
  return data;
}
