/** Increment this version whenever the customer-facing TBL terms change. */
export const TABLE_AGREEMENT_VERSION = 'tbl-2026-10-07-v2';
/** Preserve each version's accepted policy when the current agreement changes. */
export const TABLE_NO_CHANGES_AGREEMENT_VERSIONS = ['tbl-2026-10-07-v2'];
export const TABLE_AGREEMENT_TEXT =
  'การจองโต๊ะ (TBL) เป็นบริการสำหรับบุคคลภายนอกเท่านั้น ผู้จองและผู้เข้าร่วมกิจกรรมไม่สามารถนั่งร่วมโต๊ะกับผู้ต้องขังได้ ' +
  'เมื่อท่านยอมรับข้อตกลงและยืนยันการจองแล้ว รายละเอียดการจองถือเป็นที่สิ้นสุด ไม่สามารถขอแก้ไข เปลี่ยนแปลง เลื่อนวัน หรือยกเลิกการจองได้ ' +
  'เมื่อท่านโอนเงินหรือชำระค่าบริการผ่าน PromptPay แล้ว ทางคาเฟ่จะไม่คืนเงิน ไม่ว่าทั้งหมดหรือบางส่วน ในทุกกรณี';

export function tableAgreementError(body: Record<string, unknown>): string | null {
  if (body.tableAgreementAccepted !== true || body.tableAgreementVersion !== TABLE_AGREEMENT_VERSION) {
    return 'กรุณาอ่านและยอมรับข้อตกลงการจองโต๊ะ (TBL): ไม่สามารถนั่งร่วมโต๊ะกับผู้ต้องขัง ไม่สามารถแก้ไข เปลี่ยนแปลง หรือยกเลิกหลังยืนยันการจอง และไม่สามารถขอคืนเงินหลังชำระค่าบริการ';
  }
  return null;
}
