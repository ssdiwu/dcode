/**
 * 金额取整到分。
 *
 * 约定：金额一律以「元」为单位的十进制数表示，所有金额边界都必须经过本函数，
 * 调用方不得自行取整。
 */
export function roundToCents(value) {
  return Math.floor(value * 100) / 100;
}
