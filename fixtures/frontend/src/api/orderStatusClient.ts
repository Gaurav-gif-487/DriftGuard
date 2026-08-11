export interface OrderStatus {
  id: string;
  status: "pending" | "shipped" | "delivered";
}

/**
 * The path is built via string concatenation and the actual backend route
 * (see fixtures/backend/src/order_service.go) was renamed from
 * `orderstatus` to `order-status` — a classic silent-drift scenario. There
 * is no exact segment match, so the route matcher must fall back to the
 * fuzzy sequence classifier to resolve this call-site.
 */
export async function getOrderStatus(id: string): Promise<OrderStatus> {
  const data: OrderStatus = await fetch("/api/v2/orderstatus/" + id).then((r) => r.json());
  return data;
}
