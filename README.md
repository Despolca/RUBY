# RUBY Analyzer (Phiên bản Độc lập)

Tiện ích mở rộng bên thứ ba độc lập dành cho SillyTavern 1.16+. Dựa trên số tầng hội thoại để định kỳ gọi AI thực hiện các nhiệm vụ phân tích nhân vật, sau đó ghi kết quả vào Worldbook của cuộc trò chuyện.

Hoạt động hoàn toàn tách biệt khỏi plugin máy chủ (host plugin), chỉ sử dụng API tiện ích mở rộng chính thức của SillyTavern (`SillyTavern.getContext()`), các lệnh STscript gốc và hệ thống sự kiện nguyên bản.

## Tính năng

- **Lắng nghe ngầm không cảm giác (Background Listening)**: Dựa trên các sự kiện nguyên bản của Tavern (`GENERATION_ENDED` / `CHAT_CHANGED` / `MESSAGE_RECEIVED`), tự động phán đoán vị trí chu kỳ sau mỗi phản hồi của AI, đến điểm sẽ âm thầm thực thi phân tích, không chiếm dụng giao diện (frontend), không làm gián đoạn cuộc trò chuyện.
- **Điều phối chu kỳ (Cycle Scheduling)**: Vị trí chu kỳ = `((Tầng phản hồi của AI - 1) % Độ dài chu kỳ) + 1`, tính toán trực tiếp bằng pure function; các tầng bị lọt (miss) sẽ tự động tích lũy và bù đắp; hỗ trợ thực thi tuần tự và độc lập nhiều nhiệm vụ tại cùng một vị trí.
- **Đọc tăng dần (Incremental Reading)**: Mỗi nhiệm vụ duy trì độc lập một "Dấu trang đã đọc" (metadata của cuộc trò chuyện), chỉ đọc các tầng mới kể từ lần trước (bao gồm cả văn bản bị ẩn), mỗi lần tối đa 20 tầng; giới hạn văn bản cho một lần là **200,000 ký tự**, phần dôi ra sẽ bị loại bỏ (giới hạn này chỉ áp dụng cho văn bản hội thoại, các mục tham chiếu và trích dẫn đầu ra phân tích vẫn được giữ nguyên vẹn, tuyệt đối không bị mất do cắt xén).
- **Giao diện tóm tắt (Xiaobaix / SP·Database / Yuzuki Memory Table)**: Tab "Giao diện tóm tắt" trong bảng điều khiển người chơi có thể kích hoạt tóm tắt cốt truyện của Xiaobaix, tóm tắt dạng bảng của SP·Database hoặc tóm tắt bảng ký ức yuzuki-Memory — khi phân tích, các tầng đã được tóm tắt sẽ dùng nội dung tóm tắt thay thế cho văn bản gốc để tiêm (inject), các tầng mới sau ranh giới tóm tắt vẫn đọc văn bản gốc như bình thường; vị trí chu kỳ, đếm số tầng, tính toán dấu trang nhiệm vụ hoàn toàn không bị ảnh hưởng; tự động chuyển về chế độ thuần văn bản gốc khi chưa cài đặt hoặc không có dữ liệu. Xiaobaix đọc các tóm tắt có cấu trúc (sự kiện/sự thật nhân vật/giai đoạn cốt truyện) trong metadata; SP·Database đọc các mục có thể đọc được ghi vào Worldbook (bảng tóm tắt/nhân vật quan trọng/đại cương cốt truyện, dựa trên snapshot bảng TavernDB trên tin nhắn để xác định ranh giới); Yuzuki Memory Table đọc bảng tóm tắt ký ức trong metadata `yuzukiMemory` (tiêu đề tóm tắt/nhân vật cốt lõi/số tầng/nội dung tóm tắt/vấn đề chưa giải quyết, ranh giới được xác định bởi chuỗi liên tục của hợp tập các khoảng tầng, nếu có khoảng trống giữa các tầng thì ranh giới dừng trước khoảng trống để tránh thay thế nhầm, timeline tóm tắt cốt truyện có thể được tiêm cùng, có thể tắt trong bảng điều khiển) — tất cả đều chỉ đọc (read-only), zero module coupling, không sửa đổi dữ liệu plugin; xuất/nhập cùng template cấu hình.
- **Chế độ Đạo diễn (Director Mode - Lật trang Nhiệm vụ ở Bảng điều khiển Creator để vào)**: Nút "🎬 Chế độ Đạo diễn" ở đầu trang cấu hình nhiệm vụ sẽ lật sang một giao diện độc lập. Sau khi bật chu kỳ Đạo diễn, Ruby với tư cách là đạo diễn sẽ chạy một lần ở vị trí 1 của chu kỳ này (1-2 phản hồi AI tiếp theo sau khi bật), dựa vào diễn biến câu chuyện, độ ưu tiên nhiệm vụ (số càng lớn càng ưu tiên), lịch sử đánh thức 5 chu kỳ gần nhất và thống kê lâu chưa kích hoạt, để xếp ra bảng điều phối "Vị trí -> Nhiệm vụ" cho chu kỳ này — Bảng điều phối trải qua hai cấp phân tích nghiêm ngặt (ưu tiên id nhiệm vụ, lùi về tên nhiệm vụ), nếu sai định dạng/không đầy đủ sẽ tự động thử lại theo số lần do Creator thiết lập, hết số lần thử lại sẽ hiện cảnh báo đỏ, chu kỳ chạy không tải có thể chạy lại thủ công; sau đó cứ đến vị trí kế hoạch sẽ tự động đánh thức nhiệm vụ tương ứng (tiếp tục dùng toàn bộ pipeline phân tích và dấu trang của nhiệm vụ đó, đến giờ là chạy, bỏ qua quét từ khóa), mỗi nhiệm vụ tối đa một lần mỗi chu kỳ, khoảng cách tối thiểu giữa các nhiệm vụ có thể bị ép buộc cứng (0 = do AI quyết định). Creator có thể kiểm soát: Độ dài chu kỳ, khoảng cách tối thiểu, số lần thử lại, tick chọn mục tham chiếu (Đạo diễn đọc độc quyền), chỉ số ưu tiên cho từng nhiệm vụ và phần giới thiệu tùy chọn (để trống tự động bắt khoảng 200 chữ lát cắt từ mục prompt); **Hướng dẫn mật độ xếp lịch** được tích hợp trong prompt — số lượng nhiệm vụ nên bám sát khoảng cách tối thiểu do Creator đặt ra (vd: khoảng cách 2 trong 20 tầng ≈ 9 nhiệm vụ), nếu không đặt khoảng cách thì ước tính 2~3 tầng một nhiệm vụ (20 tầng khoảng 7~10 nhiệm vụ), tránh việc xếp quá thưa trong chu kỳ dài; **Đạo diễn API** là bản sao của RUBY API (có thể đổi model riêng cho đạo diễn, trường để trống sẽ đi theo RUBY API, phương thức truyền tải như stream hoàn toàn theo cài đặt RUBY API gốc); Trong **Chế độ cực đoan (Aggressive Mode)** Đạo diễn sẽ xuất thêm "Khoảng cách đạo diễn lần sau" để tự quyết định thời gian xuất hiện tiếp theo (không bị ràng buộc bởi chu kỳ cố định); Cả hai chế độ đều được tiêm **Học tập lặp (Iterative Learning)** — số lượng kế hoạch chu kỳ trước/số lần kích hoạt thực tế/số lần người chơi chạy thủ công được dùng làm tham chiếu xếp lịch; Khi chọn model gemini 3.5 trở lên (gồm pro/flash) tự động đổi tin nhắn assistant tiền điền (prefill) phá vỡ giới hạn thành user (Google đã hủy hỗ trợ prefill); Kế hoạch điều phối ghi vào mục đóng của Worldbook chỉ để engine đọc, mỗi cấu hình đều có popup trợ giúp ?; Tắt đi sẽ khôi phục điều phối vị trí tĩnh, không mất dấu trang và dữ liệu.
- **Kho mục tham chiếu (Reference Pool) / Trích dẫn đầu ra nhiệm vụ**: Các mục Worldbook được đăng ký làm biến để tiêm vào prompt; các nhiệm vụ có thể trích dẫn chéo đầu ra của nhau (bao gồm cả việc tự trích dẫn kết quả lần trước của mình để tích lũy xuyên chu kỳ). Plugin tích hợp các mục tham chiếu **Thư viện ràng buộc (Constraint Library)** (Tiêu chuẩn kiểm tra văn mẫu, lấy từ thẻ 《Huyện Thành》 14_ConstraintLibrary.yaml): có sẵn trực tiếp trong tick chọn tham chiếu của tất cả các nhiệm vụ, nhiệm vụ mới tạo mặc định được tick chọn; nếu trong Worldbook của Creator có mục cùng tên "Thư viện ràng buộc", các mục tích hợp sẵn sẽ tự động ẩn đi, việc tick chọn và phân tích lúc chạy đều chuyển sang dùng mục của Creator (ưu tiên Worldbook lúc chạy, không cần thêm vào kho tham chiếu).
- **Chế độ viết thẻ (Tab thứ ba ✍️)**: Tích hợp toàn bộ quy trình viết thẻ của Ruby (Step0 Suy nghĩ thẩm mỹ → Step8 Prompt phân tích, bao gồm tùy chọn Step4 NSFW / Step6.5 Bàn giao / StepX Tự kiểm tra). Quy tắc và thiết lập nhân vật được tiêm dưới dạng nhấn mạnh thường trực với độ sâu 0, thứ tự 999, các lệnh bước được tiêm vào Worldbook đính kèm trò chuyện theo bước hiện tại; Creator sử dụng preset/API trò chuyện nguyên bản của mình, RUBY chỉ lắng nghe — sau khi phát hiện đánh dấu hoàn thành yaml của mỗi bước sẽ tự động ghi sản phẩm vào Worldbook 《ruby viết thẻ bản nháp》 (nội dung nhân vật xếp sau nhân vật theo thứ tự, thế giới/NPC/tổng quan xếp trước nhân vật, prompt phân tích vào mục đóng và tự động điền từ khóa tên nhân vật), đồng thời tự động chuyển sang bước tiếp theo; **Bản nháp dạng nhân vật chia mục theo nhân vật**: Step3 Thẻ nhân vật / Step4 Hồ sơ NSFW / Step5 NPC (mỗi NPC hoặc nhóm là một mục độc lập) / Step8 Prompt phân tích đều được lưu thành các mục độc lập theo thân phận nhân vật, chạy lại nhân vật cùng tên → cập nhật mục gốc, nhân vật khác tên (độ tương đồng tên thấp) → lưu thành mục mới, hỗ trợ thêm nhân vật mới liên tục mà không ghi đè lẫn nhau; Hướng dẫn bước hiển thị đồng bộ trong bong bóng cạnh quả cầu nổi; Tiến độ lưu trong metadata trò chuyện, đổi cuộc trò chuyện không bị nhầm lẫn tiến độ.
- **Quả cầu nổi (Floating Orb) + Bảng điều khiển hoàn chỉnh**: Có thể kéo thả quả cầu nổi (Avatar nhân vật cắt tròn + Huy hiệu trạng thái ở dưới: √ xanh = Đang lắng nghe / Điểm xanh lam nhấp nháy = Đang phân tích / × đỏ = Lỗi / Điểm xám = Chờ (Standby) / ✎ tím = Phiên viết thẻ) để mở bảng cấu hình bằng một cú nhấp; Thanh cài đặt tiện ích mở rộng của Tavern cung cấp công tắc hiển thị quả cầu nổi và thanh kéo kích thước (tối đa 60px, có thể thu nhỏ dần), cũng có thể dùng lệnh `/ruby` để mở bảng điều khiển.
- **Cấu hình trung tâm thẻ (Card-centric Configuration - Không có nhiệm vụ toàn cục)**: Cấu hình nhiệm vụ được ghi vào trường `data.extensions` của thẻ nhân vật thông qua API `writeExtensionField` chính thức của Tavern, **khi xuất/chia sẻ thẻ nhân vật, cấu hình sẽ đi kèm theo thẻ**, nhập (import) vào môi trường khác sẽ tự động có hiệu lực ngay lập tức; sau khi mở thẻ nhân vật, việc nhập template hoặc tạo mới/sửa đổi nhiệm vụ sẽ **tự động liên kết (bind) với thẻ hiện tại**; Engine chỉ thực thi các cấu hình của thẻ nhân vật đã được liên kết, nếu chưa mở thẻ/chưa liên kết thì bảng điều khiển sẽ nhắc nhở liên kết (Giới hạn nhiệm vụ theo nhân vật đã bị loại bỏ — cấu hình đi theo thẻ, không cần chỉ định lặp lại).
- **Bảo mật API**: Khóa (Key) chỉ lưu trữ trong cài đặt tiện ích mở rộng của máy cục bộ, tuyệt đối không xâm nhập vào thẻ nhân vật / Worldbook / template xuất ra; Yêu cầu endpoint tùy chỉnh được máy chủ Tavern chuyển tiếp (không có CORS, khóa không bị lộ ở frontend).
- **Đa phương án cấu hình + Xuất/Nhập Template**: Chuyển đổi linh hoạt giữa nhiều phương án bất cứ lúc nào; Template JSON cắm và chạy (plug-and-play), tương thích với định dạng template phiên bản cũ.
- **Kênh cập nhật nguyên bản**: manifest đã bật `auto_update`, tự động/thủ công cập nhật thông qua Trình quản lý tiện ích mở rộng của Tavern.

## Cài đặt

### Cách 1: Cài đặt qua Trình quản lý tiện ích mở rộng (Khuyên dùng)

Sau khi đẩy thư mục này lên kho Git, vào SillyTavern -> Tiện ích mở rộng -> Cài đặt tiện ích mở rộng (Install Extension) điền địa chỉ kho lưu trữ vào để cài đặt.

### Cách 2: Đặt thủ công

Sao chép thư mục `ruby-analyzer` vào:

```
SillyTavern/public/scripts/extensions/third-party/ruby-analyzer
```

Làm mới (Refresh) trang là sẽ tự động tải.

## Các kênh API

Toàn bộ các lệnh gọi phân tích đều đi qua kênh của Tavern (do dịch vụ frontend của Tavern khởi xướng, máy chủ Tavern chuyển tiếp ra ngoài), không tồn tại bất kỳ kết nối trực tiếp độc lập nào từ trình duyệt ra bên ngoài; toàn bộ quá trình thực thi bất đồng bộ (asynchronous), không gây tắc nghẽn (block) cuộc trò chuyện.

| Kênh | Luồng | Mô tả |
|---|---|---|
| API chính của Tavern | `generateRaw` nguyên bản (gọi quiet) | Chỉ mượn luồng chính của Tavern để gửi: **Bỏ qua việc tiêm prompt của preset** — Prompt chính, Jailbreak, Thẻ nhân vật, Lịch sử trò chuyện đều không được đưa vào ngữ cảnh (context), những gì gửi đi chỉ là tin nhắn phá vỡ giới hạn và prompt nhiệm vụ do tự RUBY lắp ráp (cùng cơ chế với prompt im lặng của bản thân Tavern); Các tham số tạo (generation parameters) của RUBY được ghi đè lên yêu cầu này thông qua hook sự kiện `CHAT_COMPLETION_SETTINGS_READY` chính thức. Yêu cầu gửi ra có cùng nguồn và định dạng với tạo (generation) thông thường |
| Endpoint tùy chỉnh tương thích OpenAI | `ChatCompletionService` nguyên bản (Dịch vụ yêu cầu chính thức của ST 1.16) | Dịch vụ yêu cầu chat completion do Tavern chính thức cung cấp cho các tiện ích mở rộng: Cùng một endpoint backend, cùng một quy ước lắp ráp payload, cùng một bộ phân tích SSE (`EventSourceStream` + `getStreamingReply`). Điền địa chỉ đến phần phiên bản (ví dụ `https://api.deepseek.com/beta`), máy chủ sẽ tự động nối thêm `/chat/completions`; có thể kéo danh sách model bằng một cú nhấp |

## Lệnh gạch chéo (Slash Commands)

```
/ruby                    Mở bảng điều khiển
/ruby status             Xem trạng thái engine
/ruby run task=1         Thực thi thủ công nhiệm vụ #1
/ruby run startup=true   Thực thi thủ công nhiệm vụ khởi đầu
/ruby run all=true       Thực thi thủ công toàn bộ nhiệm vụ đã bật
/ruby reload             Tải lại cấu hình (có hiệu lực sau khi chuyển đổi liên kết/phương án)
/ruby cw                 Mở tab viết thẻ
/ruby cw status          Xem trạng thái phiên viết thẻ
/ruby cw action=start    Bắt đầu phiên viết thẻ (có thể thêm step=Step3 để chỉ định bước bắt đầu)
/ruby cw action=end      Kết thúc phiên viết thẻ (giữ lại bản nháp)
```

## Chế độ viết thẻ (Tab thứ ba ✍️)

Tích hợp quy trình viết thẻ của "Máy phân tích đa năng/Mục RUBY" vào trong plugin, **đi qua luồng nguyên bản của Tavern**: Creator sử dụng preset và API của riêng mình để trò chuyện với Ruby, RUBY chỉ lắng nghe, không thay mặt gửi tin nhắn.

- **Bắt đầu phiên (Session)**: Nhấp "Bắt đầu phiên viết thẻ" tại bất kỳ điểm trò chuyện nào, RUBY sẽ tiêm thiết lập nhân vật Ruby + Quy tắc bước (độ sâu 0, thứ tự 999 nhấn mạnh thường trực) và lệnh bước hiện tại (bao gồm mục giải thích bước tùy chọn) vào Worldbook đính kèm trò chuyện
- **Chế độ kép Nhanh/Trò chuyện**: Chế độ nhanh = Tự động chuyển đổi sau khi phát hiện đánh dấu hoàn thành (mặc định); Chế độ trò chuyện = Hiện hộp thoại xác nhận trước khi chuyển đổi, có tùy chọn "Tôi vẫn muốn trò chuyện thêm" để tiêm mục tạm thời "Creator chưa hoàn toàn hài lòng, tiếp tục thảo luận đừng vội kết luận" (tự động xóa khi chuyển sang giai đoạn tiếp theo), hỗ trợ điều chỉnh Ruby dài hạn
- **Nhận diện hoàn thành nghiêm ngặt**: Tóm tắt yaml của Step0-4 cần chứa các trường bắt buộc (ví dụ: Step1 cần "Kinh nghiệm nhân sinh + Sức căng nội tâm", Step3 cần "character + Cốt lõi nhân vật + Tiêu chuẩn viết") thì mới tính là hoàn thành, các đoạn nháp do Ruby hiển thị sẽ không kích hoạt chuyển đổi nhầm
- **Tự động dọn dẹp dư thừa**: Bước vào Step4 tự động xóa các mục tiêm và bản nháp của Step1/2; Bước vào Step8 xóa Step7; Step6.5 đã bị loại bỏ (tự động dọn dẹp phần thừa); Sau khi tổng quan kết thúc, chỉ giữ lại các thiết lập thẩm mỹ/nhân vật/NSFW và bản nháp prompt phân tích, toàn bộ các mục RUBY khác sẽ bị xóa sạch
- **Kết thúc tổng quan (🏁 Vào thủ công)**: Sau khi hoàn tất tất cả, nhấp "Tổng quan", Ruby xuất ra yaml chứa "Người chơi đã hoàn thành", sau đó tự động thực hiện dọn dẹp cuối cùng và kết thúc phiên
- **Ghi bản nháp vào 《ruby viết thẻ bản nháp》**: Nội dung nhân vật (Step0-4) xếp sau nhân vật theo thứ tự bước (order 100+); Thiết lập NPC, tổng quan nhân vật, bàn giao sáng tác xếp trước nhân vật; Prompt phân tích đưa vào **Mục đóng** (order 200+), và tự động điền từ khóa tên nhân vật theo tag `<TênNhânVật_LoạiPhânTích>`; Từ khóa tổng quan nhân vật điền "Tổng quan nhân vật" + Tên nhân vật
- **Bong bóng giải thích bước**: Khi chuyển bước, một bong bóng giải thích tương ứng sẽ bật lên bên cạnh quả cầu nổi (có thể tắt, tự động thu gọn sau 60 giây), cũng có thể tắt tính năng tiêm trong tùy chọn
- **Ghi nhớ tiến độ**: Tiến độ các bước được lưu trong metadata của trò chuyện, mở lại trò chuyện tự động khôi phục; Đổi trò chuyện không ảnh hưởng lẫn nhau
- **Kết thúc phiên**: Bản nháp được giữ lại trong 《ruby viết thẻ bản nháp》 có thể mở ra kiểm tra bất cứ lúc nào; "Kết thúc và Xóa sạch" sẽ xóa toàn bộ các mục viết thẻ do RUBY tạo ra
- Dữ liệu viết thẻ được `tools/build-cardwriter-data.mjs` tạo ra từ thư mục nguồn "Mục RUBY", sau khi cập nhật văn bản, chỉ cần chạy lại script là được

## Hệ thống cấp bậc Cấu hình (Mô hình Trung tâm Thẻ)

Cấu hình nhiệm vụ của RUBY **chỉ tồn tại cùng với thẻ nhân vật**, được lưu trong trường `data.extensions.RubyAnalyzer` của tệp JSON thẻ nhân vật:

- Sau khi mở thẻ nhân vật, việc nhập template, tạo mới hoặc sửa đổi nhiệm vụ sẽ **tự động ghi vào thẻ nhân vật hiện tại** (lưu lần đầu là tự động liên kết)
- Engine chỉ chạy các cấu hình của **thẻ nhân vật đã liên kết**; khi chưa liên kết sẽ ở trạng thái chờ (standby), và nhắc nhở liên kết trên bảng điều khiển chính/trang liên kết
- Khi chưa mở thẻ nhân vật, cấu hình được lưu tạm tại `extensionSettings.RubyAnalyzer.global` (Cấp độ toàn cục của máy cục bộ, không xuất ra cùng thẻ), bảng điều khiển sẽ nhắc nhở mở thẻ nhân vật
- Liên kết cục bộ phiên bản cũ (`characterConfigs`) tự động được đọc tương thích, khi lưu sửa đổi sẽ tự động chuyển (migrate) vào thẻ nhân vật
- Thông tin xác thực API (`api`) và tùy chọn giao diện (`ui`) luôn chỉ được lưu trong `settings.json` của máy cục bộ, tuyệt đối không đưa vào thẻ nhân vật

## Cấu trúc Dự án

```
ruby-analyzer/
├── manifest.json      Manifest tiện ích mở rộng (Đã bật auto_update)
├── index.js           Đầu vào (Entry point): Khởi tạo, đăng ký lệnh /ruby
├── style.css          Style cho Quả cầu nổi + Bảng điều khiển
└── src/
    ├── env.js         Truy cập môi trường, STscript Executor, Log
    ├── config.js      Chế độ cấu hình, Lớp lưu trữ (Toàn cục/Liên kết nhân vật), Cài đặt API
    ├── scheduler.js   Pure function chu kỳ (Tính vị trí, Thu thập nhiệm vụ, Quét từ khóa)
    ├── reader.js      Phân loại tin nhắn, Đọc tăng dần, Quản lý dấu trang
    ├── worldbook.js   Đọc/Ghi Worldbook (STscript nguyên bản + loadWorldInfo/saveWorldInfo)
    ├── jailbreak.js   Lắp ráp tin nhắn phá giới hạn (system/assistant/user + vị trí tiêm)
    ├── ai.js          Lớp gọi AI (generateRaw / Proxy backend + Luồng SSE)
    ├── engine.js      Điều phối sự kiện, Vòng lặp bù đắp, Pipeline phân tích
    ├── cardwriter.js  Engine chế độ viết thẻ (Tiêm bước/Kiểm tra hoàn thành/Ghi nháp/Tự động chuyển đổi)
    ├── cardwriter-data.js  Dữ liệu bước viết thẻ (Quy tắc tích hợp/Thiết lập nhân vật/Phụ lục/Lệnh bước, tạo bằng script tools)
    ├── orb.js         Quả cầu nổi có thể kéo thả (Avatar + Huy hiệu trạng thái + Bong bóng bước viết thẻ)
    ├── orb-avatar.js  Tài nguyên avatar quả cầu nổi (Nhúng data URI, không có yêu cầu bên ngoài)
    ├── settings.js    Ngăn kéo thanh cài đặt tiện ích Tavern (Công tắc quả cầu nổi)
    └── panel.js       Bảng cấu hình (Ba giao diện: Người chơi/Creator/Viết thẻ)
```

## Khác biệt so với phiên bản cũ (Phiên bản nhúng trong host plugin)

- Cơ chế kích hoạt được chuyển từ callback của host plugin sang sự kiện nguyên bản của Tavern, hành vi tương đương và đáng tin cậy hơn
- Lệnh gọi API được đổi thành `generateRaw` (API chính) hoặc proxy backend của Tavern (Endpoint tùy chỉnh), prompt lớn không còn đi qua phân tích command line nữa
- Việc tích hợp tóm tắt cốt truyện của host plugin không còn tồn tại; nếu cần tham khảo bối cảnh lịch sử, chỉ cần thêm các mục tóm tắt vào kho tham chiếu là được
- Việc cập nhật không cảm giác được giao cho kênh cập nhật chính thức của Trình quản lý tiện ích mở rộng Tavern
- Lưu trữ cấu hình được chuyển từ hệ thống nhiệm vụ máy chủ sang cấu trúc hai lớp độc lập là Liên kết nhân vật / Toàn cục; Template JSON xuất ra từ phiên bản cũ có thể được nhập trực tiếp

## Template Cấu hình (Plug-and-play)

Trang nhập (Import) tương thích với ba thế hệ định dạng template, JSON xuất ra từ phiên bản cũ có thể nhập trực tiếp:

| Nguồn | Dấu hiệu nhận biết | Hành vi nhập (Import) |
|---|---|---|
| Plugin này v3 | `_meta.version: 3.0.0`, mảng presets chứa `cyclePositions`/`keywordScan`/`characters` | Bảo toàn 100% tất cả các trường (Round-trip fidelity) |
| Bản cũ v2.x (Đa phương án) | `_meta.type: RUBY_ANALYZER_PRESET` + mảng `presets`, nhiệm vụ chỉ có `triggerFloor` | Nhập độc lập từng phương án; `triggerFloor` tự động chuyển thành vị trí chu kỳ; `startupTask.triggerFloors` được chuyển đổi đồng bộ; `gen`/`jailbreak`/các tag được nhập cùng lúc |
| Bản cũ v1.x (Đơn phương án) | Không có `presets`, cấp cao nhất là `tasks`/`referencePool`/`startupTask` | Được đóng gói thành phương án đơn có tên "Phương án đã nhập" (Imported preset) để nhập |

Trước khi nhập sẽ hiển thị phiên bản nguồn cùng số lượng phương án/nhiệm vụ và yêu cầu xác nhận; Sau khi nhập dùng lệnh `/ruby reload` để có hiệu lực. Tương thích ngược: Template xuất ra từ plugin này cũng có thể được phiên bản cũ nhập (Nhiệm vụ ở nhiều vị trí sẽ bị giáng cấp (degrade) về vị trí đầu tiên).

## Lưu ý về Bảo mật

- Khóa API (API Key) chỉ được lưu trong phần cài đặt tiện ích mở rộng của `settings.json`, các template, thẻ nhân vật và Worldbook được xuất ra đều không chứa khóa
- Liên kết thẻ nhân vật chỉ ghi dữ liệu cấu hình nhiệm vụ (phương án/nhiệm vụ/kho tham chiếu/phá giới hạn/tham số tạo) vào `data.extensions.RubyAnalyzer`, không bao gồm thông tin xác thực API
- Toàn bộ các yêu cầu đều được gửi qua dịch vụ yêu cầu chính thức của Tavern, do máy chủ Tavern chuyển tiếp, yêu cầu gửi ra có hình thức giống hệt với việc tạo văn bản bình thường của Tavern (không có đặc điểm client độc lập); Ở phía trình duyệt không tồn tại lệnh gọi trực tiếp đến nhà cung cấp dịch vụ model
- Ô nhập khóa trên bảng điều khiển là kiểu mật khẩu (password), không hiển thị văn bản rõ ràng (plaintext) trên giao diện