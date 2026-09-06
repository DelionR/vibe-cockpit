export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

export function postTransfer(body: Partial<Transfer>) {
  if (!body.from || !body.to) throw new Error('from/to required');
  const amount = Number(body.amount) || 0;
  return { ok: true, debited: body.from, credited: body.to, amount };
}
