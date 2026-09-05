export const availableActions = (deal, admin, now = Date.now()) => {
  if (!["owner", "manager"].includes(admin.role)) return [];
  const assigned = deal.assigned_admin_id;
  if (assigned && Number(assigned) !== Number(admin.telegram_id) && admin.role !== "owner") return [];
  if (["completed", "cancelled"].includes(deal.status)) return [];
  if (!assigned) return ["new", "reviewing"].includes(deal.status) ? ["assign"] : admin.role === "owner" ? ["transfer"] : [];
  const actions = ["message", "transfer"];
  if (["reviewing", "rate_offered"].includes(deal.status)) actions.push("offer-rate");
  if (deal.status === "payment_review" && !deal.payment_confirmed_at) actions.push("payment-confirmed");
  if (["rate_accepted", "payment_review"].includes(deal.status) && (deal.payment_method === "Наличные" || deal.payment_confirmed_at) && new Date(deal.rate_expires_at).getTime() > now) actions.push("start-exchange");
  if (deal.status === "exchange_in_progress") actions.push("complete");
  if (["new", "reviewing", "rate_offered", "rate_accepted", "awaiting_payment", "payment_review"].includes(deal.status)) actions.push("cancel");
  if (["reviewing", "rate_offered", "rate_accepted", "awaiting_payment", "payment_review", "exchange_in_progress"].includes(deal.status)) actions.push("dispute");
  return actions;
};
