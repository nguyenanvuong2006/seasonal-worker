import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { ShieldCheck, Phone, ArrowLeft } from "lucide-react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Điều khoản sử dụng | Seasonal Internship",
  description: "Điều khoản sử dụng đối với ứng viên đăng ký tập nghề và làm việc thời vụ tại Dalat Hasfarm.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen w-full bg-[#f8f4eb] pb-20 text-fg">
      {/* Header */}
      <header className="border-b border-[#eadfcb] bg-[#fffdf8] px-6 py-4 md:px-10 lg:px-14">
        <div className="mx-auto flex max-w-[1000px] items-center justify-between">
          <BrandLogo size="md" />
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-[#d9e2db] bg-white px-4 py-2 text-xs font-bold text-primary shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <ArrowLeft className="h-4 w-4" /> Về trang chủ
          </Link>
        </div>
      </header>

      {/* Content */}
      <div className="mx-auto mt-10 w-full max-w-[1000px] px-4 md:px-6">
        <div className="rounded-[26px] border border-[#e7dece] bg-white p-6 shadow-[0_18px_45px_rgba(35,55,38,0.05)] md:p-10 lg:p-14">
          <div className="mb-10 border-b border-[#e7dece] pb-8">
            <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-[#174f2b]">
              <ShieldCheck className="h-5 w-5 text-[#f58220]" aria-hidden /> Dalat Hasfarm
            </p>
            <h1 className="mt-4 text-[32px] font-black leading-tight tracking-tight text-[#154c2b] md:text-[42px]">
              Điều khoản sử dụng
            </h1>
            <p className="mt-4 text-[15px] font-medium text-fg-secondary">
              Ngày hiệu lực: 23/09/2026
            </p>
          </div>

          <div className="space-y-8 text-[15px] leading-relaxed text-[#34483a]">
            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">1. Phạm vi sử dụng hệ thống</h2>
              <p>
                Hệ thống này được Dalat Hasfarm cung cấp như một nền tảng hỗ trợ vận hành nhằm tiếp nhận thông tin đăng ký tập nghề và tuyển dụng thời vụ.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">2. Điều kiện sử dụng</h2>
              <p>
                Người sử dụng phải đáp ứng các yêu cầu về độ tuổi lao động và tự nguyện cung cấp các thông tin liên quan theo yêu cầu của Dalat Hasfarm phục vụ cho mục đích tuyển dụng. Khi sử dụng hệ thống để đăng ký và gửi thông tin, bạn có trách nhiệm đọc và tuân thủ các điều khoản sử dụng được công bố tại đây.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">3. Trách nhiệm cung cấp thông tin chính xác</h2>
              <p>
                Bạn có trách nhiệm đảm bảo các thông tin đăng ký (bao gồm số CCCD, Họ tên, Ngày sinh, Số điện thoại và các thông tin liên quan) là hoàn toàn chính xác. Việc cung cấp thông tin sai lệch có thể dẫn đến việc từ chối hồ sơ.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">4. Quy trình tiếp nhận hồ sơ</h2>
              <p>
                Sau khi gửi thông tin, hệ thống sẽ tiến hành đối chiếu hồ sơ và xếp bộ phận làm việc phù hợp với nhu cầu hiện tại. Kết quả sẽ được thông báo qua các kênh liên hệ mà bạn đã đăng ký hoặc có thể kiểm tra trực tiếp qua chức năng &quot;Tra cứu&quot;.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">5. Không cam kết tuyển dụng/tập nghề</h2>
              <p>
                Việc nộp hồ sơ qua hệ thống chỉ mang tính chất ghi nhận thông tin. Hệ thống này <strong>không</strong> tạo ra bất kỳ hợp đồng lao động, hợp đồng tập nghề, hay lời mời nhận việc chính thức nào cho đến khi có các tài liệu được ký kết rõ ràng hoặc sự đồng ý từ bộ phận nhân sự có thẩm quyền.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">6. Tra cứu và xác minh thông tin</h2>
              <p>
                Bạn có thể sử dụng thông tin CCCD và Số điện thoại đã đăng ký để tra cứu tình trạng hồ sơ. Vui lòng bảo mật các thông tin cá nhân của mình để tránh người khác tra cứu trái phép.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">7. Tài liệu điện tử và xác nhận</h2>
              <p>
                Trong quá trình xử lý, hệ thống có thể cung cấp các tài liệu điện tử để bạn xem xét và xác nhận. Hệ thống ghi nhận nội dung xác nhận, thời điểm xác nhận và các thông tin bằng chứng kỹ thuật liên quan để phục vụ việc đối chiếu, lưu vết và xử lý nghiệp vụ.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">8. Hành vi không được phép</h2>
              <p className="mb-2">Khi sử dụng hệ thống, bạn không được phép:</p>
              <ul className="list-inside list-disc space-y-2">
                <li>Sử dụng thông tin định danh giả hoặc của người khác.</li>
                <li>Can thiệp, phá hoại hoặc cố ý làm gián đoạn hoạt động của hệ thống.</li>
                <li>Sử dụng các công cụ tự động để nộp hồ sơ hàng loạt trái với quy định.</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">9. Tạm ngừng/thay đổi dịch vụ</h2>
              <p>
                Dalat Hasfarm có quyền tạm ngừng hệ thống để bảo trì, sửa lỗi, hoặc thay đổi các chức năng của dịch vụ vào bất kỳ lúc nào mà không cần báo trước.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">10. Giới hạn trách nhiệm hợp lý</h2>
              <p>
                Trong phạm vi pháp luật cho phép, Dalat Hasfarm sẽ không chịu trách nhiệm cho các sự cố gián đoạn dịch vụ, lỗi kết nối mạng ngoài tầm kiểm soát, hoặc các thiệt hại gián tiếp phát sinh từ việc bạn sử dụng nền tảng này.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">11. Thay đổi điều khoản</h2>
              <p>
                Chúng tôi có thể cập nhật các Điều khoản sử dụng này khi quy trình hoạt động thay đổi. Vui lòng kiểm tra lại trang này để nắm bắt thông tin mới nhất.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">12. Thông tin liên hệ</h2>
              <p>
                Nếu có bất kỳ vấn đề gì trong việc sử dụng hệ thống, bạn có thể liên hệ:
              </p>
              <div className="mt-4 flex max-w-sm items-center gap-4 rounded-2xl border border-[#efd7bd] bg-[#fff8ef] p-5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-[#174f2b] shadow-sm">
                  <Phone className="h-6 w-6" />
                </span>
                <div>
                  <p className="text-[13px] font-black uppercase text-[#174f2b]">Hỗ trợ nhân sự</p>
                  <a href="tel:+842633620295" className="mt-1 block text-lg font-black text-[#ef6c00] transition hover:underline">
                    0263 3620295
                  </a>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Footer Links */}
        <div className="mt-8 flex items-center justify-center gap-6 text-sm font-semibold text-[#34483a]">
          <Link href="/privacy" className="transition hover:text-[#f58220] hover:underline hover:underline-offset-4">
            Xem Chính sách bảo mật
          </Link>
        </div>
      </div>
    </main>
  );
}
