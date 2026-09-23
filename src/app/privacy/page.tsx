import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { ShieldCheck, Phone, ArrowLeft } from "lucide-react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chính sách bảo mật | Seasonal Internship",
  description: "Chính sách bảo mật thông tin dành cho hệ thống đăng ký tập nghề và làm việc thời vụ tại Dalat Hasfarm.",
};

export default function PrivacyPage() {
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
              Chính sách bảo mật thông tin
            </h1>
            <p className="mt-4 text-[15px] font-medium text-fg-secondary">
              Ngày hiệu lực: 23/09/2026
            </p>
          </div>

          <div className="space-y-8 text-[15px] leading-relaxed text-[#34483a]">
            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">1. Phạm vi áp dụng</h2>
              <p>
                Chính sách bảo mật này áp dụng cho các thông tin được thu thập thông qua Hệ thống Đăng ký Tập nghề và Tuyển dụng thời vụ (Seasonal Internship) của Dalat Hasfarm.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">2. Thông tin hệ thống có thể thu thập</h2>
              <p className="mb-2">Để phục vụ quy trình tiếp nhận, hệ thống có thể thu thập các thông tin sau:</p>
              <ul className="list-inside list-disc space-y-2">
                <li><strong>Thông tin định danh và nhân khẩu học:</strong> Số CCCD, Họ và tên, Ngày/năm sinh, Tuổi, Giới tính, Dân tộc.</li>
                <li><strong>Thông tin liên hệ:</strong> Số điện thoại, Địa chỉ thường trú, Địa chỉ nơi ở hiện tại.</li>
                <li><strong>Thông tin đăng ký:</strong> Nguyện vọng thời gian làm việc, Kênh giới thiệu, và các câu trả lời khảo sát nghiệp vụ bổ sung.</li>
                <li><strong>Thông tin quá trình làm việc:</strong> Khai báo nghỉ việc trước đó, Bộ phận được phân công, Mã định danh hệ thống nội bộ (Mã IT, Mã DW).</li>
                <li><strong>Tài liệu và Xác nhận:</strong> Phiên bản điện tử của các cam kết, hợp đồng tập nghề, chữ ký điện tử, và thời gian xác nhận.</li>
                <li><strong>Thông tin hệ thống và Bảo mật:</strong> Thời gian tương tác, lịch sử trạng thái, và siêu dữ liệu kiểm toán (audit/session metadata) liên quan đến bảo mật tài khoản và quy trình.</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">3. Mục đích sử dụng thông tin</h2>
              <p>
                Thông tin được sử dụng phục vụ quy trình tuyển dụng, tập nghề, tiếp nhận hồ sơ, đối chiếu và các hoạt động vận hành liên quan của Dalat Hasfarm.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">4. Nguồn thông tin</h2>
              <p>
                Thông tin được thu thập trực tiếp khi người dùng tự nguyện khai báo trên hệ thống, trích xuất từ mã QR trên CCCD của ứng viên (nếu ứng viên sử dụng tính năng quét mã), hoặc được kế thừa từ hồ sơ tập nghề đã có trong hệ thống nội bộ của Dalat Hasfarm (đối với ứng viên cũ).
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">5. Cách thông tin được sử dụng trong quy trình</h2>
              <p>
                Thông tin đăng ký được hệ thống sử dụng để nhận diện ứng viên mới hay cũ, từ đó tối ưu hóa việc điền đơn. Dữ liệu này giúp bộ phận Tuyển dụng đối chiếu hồ sơ, xếp bộ phận làm việc phù hợp, và liên hệ thông báo kết quả.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">6. Quyền truy cập nội bộ</h2>
              <p>
                Quyền truy cập thông tin được giới hạn theo vai trò, phân quyền và nhu cầu nghiệp vụ của các bộ phận có liên quan trong Dalat Hasfarm. Mỗi bộ phận (Tuyển dụng, Quản lý bộ phận, Hành chính) chỉ xem được thông tin cần thiết phục vụ cho công việc chuyên môn tương ứng.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">7. Tài liệu điện tử và xác nhận</h2>
              <p>
                Khi ứng viên đồng ý và xác nhận các tài liệu (như cam kết hoặc hợp đồng), hệ thống sẽ tạo tài liệu điện tử, ghi nhận chữ ký điện tử và lưu trữ URL của tài liệu cùng dấu thời gian (timestamp) để phục vụ việc tra cứu và đối chiếu sau này.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">8. Thông tin kỹ thuật và bảo mật</h2>
              <p>
                Hệ thống áp dụng các biện pháp kiểm soát truy cập, phân quyền và ghi nhận hoạt động phù hợp với chức năng vận hành để bảo vệ dữ liệu khỏi truy cập trái phép.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">9. Lưu trữ và bảo quản thông tin</h2>
              <p>
                Dữ liệu được lưu trong thời gian cần thiết để phục vụ quy trình tuyển dụng, tập nghề, đối chiếu, vận hành và các nghĩa vụ lưu trữ nội bộ áp dụng.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">10. Quyền yêu cầu kiểm tra, cập nhật thông tin</h2>
              <p>
                Ứng viên có quyền tra cứu tình trạng hồ sơ của mình thông qua tính năng &quot;Tra cứu&quot; trên hệ thống. Nếu có sai sót về thông tin cá nhân, vui lòng liên hệ bộ phận hỗ trợ để được hướng dẫn điều chỉnh.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">11. Thay đổi chính sách</h2>
              <p>
                Dalat Hasfarm có quyền cập nhật Chính sách bảo mật này khi cần thiết. Bất kỳ sự thay đổi nào sẽ được cập nhật trên trang này cùng với Ngày hiệu lực mới.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-2xl font-black text-[#154c2b]">12. Thông tin liên hệ</h2>
              <p>
                Mọi thắc mắc liên quan đến hồ sơ và chính sách bảo mật, vui lòng liên hệ:
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
          <Link href="/terms" className="transition hover:text-[#f58220] hover:underline hover:underline-offset-4">
            Xem Điều khoản sử dụng
          </Link>
        </div>
      </div>
    </main>
  );
}
