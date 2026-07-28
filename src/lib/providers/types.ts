/**
 * PROVIDER ARCHITECTURE (#19)
 * -----------------------------
 * Toàn bộ nghiệp vụ (Digital Onboarding, Notification...) chỉ được phép gọi qua
 * các interface dưới đây — KHÔNG được import thẳng SDK của 1 nhà cung cấp cụ
 * thể (googleapis, twilio...) ở tầng route/service nghiệp vụ. Muốn đổi nhà cung
 * cấp (Google Drive → SharePoint/S3, hay thêm kênh gửi Zalo/SMS thật) chỉ cần
 * viết 1 class mới implement đúng interface rồi đăng ký ở registry — KHÔNG phải
 * sửa nghiệp vụ.
 *
 * TÌNH TRẠNG TRIỂN KHAI (trung thực — xem thêm mục 10 trong HUONG_DAN_HE_THONG.md):
 * - NotificationProvider: có 1 implementation THẬT hoạt động (kênh IN_APP, xem
 *   src/lib/notifications.ts) — đã đăng ký ở registry bên dưới.
 * - StorageProvider / DocumentProvider / OtpProvider / IdentityProvider: MỚI CÓ
 *   interface (hợp đồng), CHƯA có implementation thật (StorageProvider cần tài
 *   khoản dịch vụ ngoài — Google Drive service account — mà môi trường này không
 *   có; DocumentProvider/OtpProvider phục vụ Ký điện tử #13, phụ thuộc trực tiếp
 *   vào StorageProvider nên chưa triển khai cùng đợt). Đây là quyết định có chủ
 *   đích: định nghĩa đúng hợp đồng ngay từ đầu để khi có tài khoản Google Drive/
 *   nhà cung cấp SMS-OTP, chỉ cần viết thêm 1 class — không phải thiết kế lại.
 */

/** Lưu trữ file (PDF, ảnh...) — Google Drive là 1 Adapter, có thể đổi sang SharePoint/OneDrive/S3/MinIO. */
export interface StorageProvider {
  readonly name: string;
  upload(input: {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    folderPath: string; // vd "2026/07/26"
  }): Promise<{ fileId: string; url: string; folder: string; checksum: string }>;
  getDownloadUrl(fileId: string): Promise<string>;
}

/** Sinh tài liệu (PDF hợp đồng/cam kết...) từ dữ liệu + template. */
export interface DocumentProvider {
  readonly name: string;
  generatePdf(input: {
    templateKey: string;
    data: Record<string, unknown>;
    signatureImagePng?: Uint8Array;
  }): Promise<{ bytes: Uint8Array; sha256: string }>;
}

/** Xác thực OTP — "nội bộ" nghĩa là KHÔNG qua nhà mạng SMS (theo đúng yêu cầu gốc). */
export interface OtpProvider {
  readonly name: string;
  request(subjectRef: string): Promise<{ otpId: string; expiresAt: Date }>;
  verify(otpId: string, code: string): Promise<boolean>;
}

/** Gửi thông báo — IN_APP có sẵn; ZALO/SMS/EMAIL là các Adapter tương lai. */
export interface NotificationProvider {
  readonly name: string;
  send(input: { recipientRef: string; templateKey: string; payload: Record<string, unknown> }): Promise<{ ok: boolean }>;
}

/** Xác thực danh tính bên ngoài (vd tra cứu CCCD qua cổng dân cư quốc gia) — CHƯA có nhà cung cấp nào cấu hình. */
export interface IdentityProvider {
  readonly name: string;
  verify(cccd: string): Promise<{ verified: boolean; detail?: Record<string, unknown> }>;
}
