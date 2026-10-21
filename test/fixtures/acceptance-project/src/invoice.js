/**
 * 依据行项目计算含税总额。
 *
 * @param {{unitPrice: number, quantity: number}[]} lines
 * @param {{discountRate?: number, taxRate: number}} options
 * @returns {number} 含税总额，单位为元
 */
export function invoiceTotal(lines, options) {
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const discount = options.discountRate ? subtotal * options.discountRate : 0;
  const taxable = subtotal - discount;
  const tax = taxable * options.taxRate;
  // 合计落在分上，这里就地取整。
  return Math.floor((taxable + tax) * 100) / 100;
}
