# Chỗ trống cho logo chính thức của Dalat Hasfarm

Repo này **hiện chưa có** file logo chính thức của Dalat Hasfarm. Đây là "chỗ trống" (asset
slot) đã được chuẩn bị sẵn — khi có file logo chính thức (do công ty cung cấp), hãy đặt vào
đúng đường dẫn dưới đây, không cần sửa code:

```
public/brand/dalat-hasfarm-logo.png
```

(hoặc `.svg` nếu có bản vector — xem `src/components/brand-logo.tsx`, đổi phần đường dẫn
`LOGO_SRC` sang `.svg` nếu dùng file SVG).

## Yêu cầu file

- Nền trong suốt (PNG có alpha, hoặc SVG) để hiển thị đẹp trên cả nền sáng lẫn nền tối
  (sidebar dùng nền xanh đậm, trang đăng nhập dùng nền trắng).
- Tỷ lệ khung hình gốc được giữ nguyên — component `BrandLogo` render bằng `object-contain`,
  không bóp méo ảnh dù khung chứa là hình vuông.
- Khuyến nghị kích thước tối thiểu 256×256px (hoặc SVG vector, không giới hạn kích thước).

## Vì sao không tự tạo logo tạm?

Theo yêu cầu rõ ràng của chủ dự án: **không được tự vẽ/tự tạo logo** (kể cả logo vẽ bằng CSS,
icon chung chung, hoặc dùng chữ "Dalat Hasfarm" thay cho logo) để tránh hiển thị sai lệch
thương hiệu công ty. Cho đến khi có file logo thật, `BrandLogo` sẽ hiển thị một khung trống
rõ ràng (không phải ảnh vỡ, không phải logo giả) kèm tên hệ thống dạng chữ thường.
