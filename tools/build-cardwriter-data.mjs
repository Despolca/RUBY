// Tạo src/cardwriter-data.js (module dữ liệu bước viết thẻ tích hợp) từ thư mục nguồn "Mục RUBY"
// Cách dùng: node tools/build-cardwriter-data.mjs [Thư mục Mục RUBY]
// Thư mục mặc định: ../世界书/通用分析器/RUBY条目 (tương đối so với gốc kho lưu trữ)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = resolve(process.argv[2] || join(repoRoot, '..', '世界书', '通用分析器', 'RUBY条目'));

const read = (name) => {
    const p = join(srcDir, name);
    if (!existsSync(p)) throw new Error(`source file missing: ${p}`);
    return readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
};

// Hướng dẫn chuyển đổi tự động chế độ viết thẻ RUBY: Thêm vào cuối lệnh của mỗi bước
const MODE_NOTE = `

[Hướng dẫn chuyển đổi tự động Chế độ viết thẻ RUBY]
Trong cuộc trò chuyện ở Chế độ viết thẻ RUBY hiện tại: Việc bật/tắt các mục của từng bước do RUBY tự động quản lý.
Sau khi RUBY phát hiện dấu hiệu hoàn thành của bước này (sự kết hợp giữa XML + khối code yaml được quy định trong [Giao thức đầu ra hoàn thành] ở cuối lệnh bước), nó sẽ tự động đóng mục bước hiện tại và mở mục bước tiếp theo, người sáng tạo không cần chuyển đổi worldbook theo cách thủ công, và trong lời kết cũng không cần nhấn mạnh việc chuyển đổi worldbook thủ công.
Nếu người sáng tạo muốn chuyển đến/quay lại bước nào đó theo cách thủ công, hãy bảo họ mở tab "Viết thẻ" trên bảng điều khiển RUBY để thao tác.
Khi người sáng tạo bày tỏ rõ ràng muốn hoàn thành/chốt bản thảo bước hiện tại, bạn phải xuất yaml kết thúc tuân thủ nghiêm ngặt định dạng đầy đủ của giao thức này - đây là cơ sở duy nhất để quá trình chuyển đổi diễn ra.`;

// Dọn dẹp các cách diễn đạt lỗi thời: Khi viết văn bản gốc, các bước yêu cầu bật/tắt mục worldbook thủ công, bây giờ do RUBY quản lý thay.
// Thay thế/xóa các lệnh này theo từng dòng để giữ nhất quán với môi trường hiện tại.
const INSTRUCTION_LINE_RULES = [
    // Xóa toàn bộ dòng đối với các mục đăng ký bật/tắt thủ công trong danh sách đánh số của lời kết
    [/^\s*\d+\.\s*手动切换：.*$/, ''],
    // "请你手动切换到StepX，然后我会…" → Bản tự động
    [/请你手动切换到(Step[\d.]+(?:或Step[\d.]+)?[^\n，。]*?)，然后我会/, 'Sau khi RUBY phát hiện dấu hiệu hoàn thành, nó sẽ tự động chuyển sang $1. Sau đó tôi sẽ'],
    [/请你手动切换到下一个step。/, 'Sau khi RUBY phát hiện dấu hiệu hoàn thành, nó sẽ tự động chuyển sang step tiếp theo.'],
    [/请你手动切换到(Step[\d.]+)。/, 'Sau khi RUBY phát hiện dấu hiệu hoàn thành, nó sẽ tự động chuyển sang $1.'],
    // Điều khoản ràng buộc: "要求创作者手动切换到StepX" → Tự động
    [/要求创作者手动切换到(Step[\d.]+(?:或Step[\d.]+)?)/, 'Sau khi RUBY phát hiện dấu hiệu hoàn thành, tự động chuyển sang $1'],
    [/完成后要求创作者手动切换到(Step[\d.]+)/, 'Sau khi hoàn thành, RUBY sẽ tự động chuyển sang $1'],
    // Chỉ dẫn trong phản hồi ranh giới
    [/请先完成(Step[\d.-]+)，然后手动切换。/, 'Vui lòng hoàn thành $1 theo thứ tự, việc chuyển đổi do RUBY tự động xử lý.'],
    [/请手动切换到正确的step。/, 'Việc chuyển đổi bước do RUBY tự động xử lý, không cần thao tác worldbook thủ công.'],
    [/请你手动切换到(Step[\d.]+)$/, 'RUBY sẽ tự động chuyển sang $1'],
    // Lệnh bật/tắt thủ công nguyên câu của lời kết Step7
    [/去世界书把(Step[\d.]+_[^\n]+?)关掉，打开(Step[\d.]+_[^\n]+?)。/, 'Sau khi RUBY phát hiện dấu hiệu hoàn thành, nó sẽ tự động chuyển sang $2.'],
];

// Các dòng lỗi thời trong văn bản hướng dẫn (bong bóng): Bật/tắt mục thủ công/Lưu worldbook thủ công → RUBY quản lý thay
const GUIDE_LINE_RULES = [
    [/^\s*-\s*完成Step[\d.]+后，去世界书把「[^」]+」关掉.*$/, '- Sau khi hoàn thành bước này, RUBY sẽ tự động chuyển sang bước tiếp theo (không cần thao tác worldbook)'],
    [/^\s*-\s*或者将这个yaml保存到世界书的临时条目中$/, '- Tóm tắt yaml do RUBY tự động chụp và ghi vào "Bản nháp viết thẻ ruby"'],
    [/^\s*-\s*或者要求Ruby输出总结yaml，保存到世界书的临时条目中$/, '- Tóm tắt yaml do RUBY tự động chụp và ghi vào "Bản nháp viết thẻ ruby"'],
    [/^\s*-\s*如果对话过长导致[逻辑记忆]力?衰退，可以将Step[\d.]+的yaml结果保存到世界书$/, '- Cuộc trò chuyện quá dài cũng không sao: RUBY sẽ lưu tóm tắt yaml của mỗi bước, không phụ thuộc vào lịch sử trò chuyện'],
    [/^\s*-\s*在世界书中新建条目，把档案放入（如：角色名_nsfw.yaml）$/, '- Hồ sơ yaml do RUBY tự động ghi vào worldbook "Bản nháp viết thẻ ruby"'],
];

function sanitizeLines(text, rules) {
    return text.split('\n').map((line) => {
        for (const [re, replacement] of rules) {
            if (re.test(line)) return replacement === '' ? '' : line.replace(re, replacement);
        }
        return line;
    }).filter((line, idx, arr) => {
        // Loại bỏ các dòng trống liên tiếp do bị xóa (giữ lại dòng trống đơn phân tách đoạn ban đầu)
        if (line === '' && arr[idx - 1] === '') return false;
        return true;
    }).join('\n');
}

// Giao thức đầu ra hoàn thành: Khi mỗi bước hoàn thành, phải xuất khối code ```yaml được bọc bởi thẻ XML.
// MATCH_KEY là trường mỏ neo để RUBY nhận diện hoàn thành - phải xuất hiện bên trong yaml (để tránh nhận diện nhầm bản nháp),
// nhưng chỉ có một từ cốt lõi ổn định, không kiểm tra nhiều lần (không thể quá khắt khe).
// Sản phẩm của các bước lenient (Step5/6) bắt đầu bằng bất kỳ khóa nào như tên người, không có từ mỏ neo ổn định: Trong giao thức
// không nhấn mạnh trường mỏ neo, đầu nhận diện được nới lỏng thành bất kỳ khối yaml nào không rỗng.
const COMPLETION_PROTOCOLS = {
    Step0: { tag: 'step0_aesthetic_summary', matchKey: 'Phục dựng câu chuyện' },
    Step1: { tag: 'step1_soul_exploration', matchKey: 'Kinh nghiệm sống' },
    Step2: { tag: 'step2_living_character', matchKey: 'Cốt lõi nhân vật' },
    Step3: { tag: 'character', matchKey: 'character:' },
    Step4: { tag: 'NSFW档案', matchKey: 'nsfw_profile' },
    Step5: { tag: 'step5_npc_design', matchKey: '' },
    Step6: { tag: 'step6_quickview', matchKey: '' },
    Step7: { tag: 'step7_analysis_plan', matchKey: 'Nhiệm vụ' },
    Step8: { tag: 'step8_analysis_prompts', matchKey: 'Nhiệm vụ:' },
};

function completionProtocolNote(stepId) {
    const p = COMPLETION_PROTOCOLS[stepId];
    if (!p) return '';
    const sampleHead = p.matchKey === 'character:'
        ? 'character: [Tên đầy đủ nhân vật]'
        : (p.matchKey ? `${p.matchKey}:` : '[Tên nhân vật/Tên mục]:');
    const anchorLine = p.matchKey
        ? `3. Nội dung yaml phải chứa trường "${p.matchKey}" (Mỏ neo để RUBY nhận diện hoàn thành, không được bỏ qua, không được đổi tên)`
        : '3. yaml lấy tên nhân vật/tên mục làm khóa cấp cao nhất, nội dung đầy đủ (RUBY nhận diện hoàn thành theo định dạng tổng thể)';
    return `

[Giao thức đầu ra hoàn thành (Phụ thuộc nhận diện tự động của RUBY, mức độ ưu tiên cao nhất)]
Việc hoàn thành bước này dựa trên việc bạn xuất "Dấu hiệu hoàn thành" - nó phải tuân thủ nghiêm ngặt định dạng sau, không được sai một ký tự nào:

<${p.tag}>
\`\`\`yaml
${sampleHead}
  [Nội dung đầy đủ...]
\`\`\`
</${p.tag}>

Yêu cầu bắt buộc về định dạng:
1. Thẻ XML <${p.tag}> và </${p.tag}> phải xuất hiện thành từng cặp, mỗi thẻ chiếm một dòng, bọc toàn bộ khối code
2. Bên trong thẻ có và chỉ có một khối code \`\`\`yaml: Dòng đầu tiên là \`\`\`yaml, dòng cuối cùng là \`\`\` (ba dấu backtick)
${anchorLine}
4. Tất cả các trường phải điền nội dung chân thực và đầy đủ - cấm dùng "...", "lược bỏ", "v.v." để giữ chỗ
5. Bên trong khối code cấm xuất hiện thêm ba dấu backtick, cấm lồng ghép khối code

⚠️ Đây là dấu hiệu duy nhất cho thấy lộ trình của bước này đã hoàn thành. Khi người sáng tạo nói "được rồi/hài lòng rồi/chốt bản thảo như vậy đi/chuyển sang bước tiếp theo", bạn phải lập tức xuất yaml kết thúc với định dạng đầy đủ như trên - không được chỉ xuất yaml mà không có thẻ, không được chỉ nói "đã hoàn thành" mà không xuất, không được viết tên thẻ thành tên khác.
⚠️ Cấm sử dụng thẻ XML và tổ hợp đầy đủ này trong lúc thảo luận bình thường, hiển thị bản nháp, xem trước giữa chừng - nó là tín hiệu hoàn thành, chỉ xuất một lần khi tóm tắt chốt bản thảo ở bước này.
⚠️ Yaml xuất ra phải đầy đủ, nhưng không nhất thiết phải hoàn hảo, người sáng tạo vẫn có thể yêu cầu bạn chỉnh sửa và chốt lại bản thảo.`;
}

const steps = [
    { id: 'Step0', name: 'Tư duy thẩm mỹ', optional: false, tool: false, file: '02_Step0：美学思考.txt', guide: '00_Step0说明_美学思考.txt' },
    { id: 'Step1', name: 'Khám phá linh hồn', optional: false, tool: false, file: '03_Step1：灵魂探索.txt', guide: '00_Step1说明_灵魂探索.txt' },
    { id: 'Step2', name: 'Xây dựng nhân vật sống động', optional: false, tool: false, file: '04_Step2：活人化塑造.txt', guide: '00_Step2说明_活人化塑造.txt' },
    { id: 'Step3', name: 'Xuất template nhân vật', optional: false, tool: false, file: '05_Step3：输出角色模板.txt', guide: '00_Step3说明_结构化输出.txt' },
    { id: 'Step4', name: 'Viết hồ sơ NSFW', optional: true, tool: false, file: '06_可选_Step4：进阶角色拆分.txt', guide: '00_Step4说明_进阶角色拆分.txt' },
    { id: 'Step5', name: 'Thiết kế NPC', optional: false, tool: false, file: '07_Step5：NPC设计.txt', guide: '' },
    { id: 'Step6', name: 'Xem lướt nhân vật và mạng lưới quan hệ', optional: false, tool: false, file: '08_Step6：人物速览与关系网.txt', guide: '' },
    { id: 'Step7', name: 'Phương hướng và Kế hoạch phân tích', optional: false, tool: false, file: '09_Step7：分析方向与规划.txt', guide: '' },
    { id: 'Step8', name: 'Viết prompt phân tích', optional: false, tool: false, file: '10_Step8：分析提示词写作.txt', guide: '' },
    { id: 'StepX', name: 'Nhiệm vụ tự kiểm tra', optional: true, tool: true, file: '16_StepX：自检任务.txt', guide: '' },
].map((s) => ({
    id: s.id,
    name: s.name,
    optional: s.optional,
    tool: s.tool,
    instruction: sanitizeLines(read(s.file), INSTRUCTION_LINE_RULES) + MODE_NOTE + completionProtocolNote(s.id),
    guide: s.guide ? sanitizeLines(read(s.guide), GUIDE_LINE_RULES) : '',
}));

// Tóm tắt lộ trình: Mỗi bước một câu, được tiêm vào mục "Lộ trình viết thẻ" thường trú (khoảng 300 token), giúp AI luôn biết toàn bộ quy trình và vị trí hiện tại
const ROADMAP_BRIEFS = {
    Step0: 'Phục dựng ý tưởng câu chuyện của người sáng tạo, xác định tông màu và khái niệm thế giới',
    Step1: 'Khám phá khát vọng, sự căng thẳng và nỗi sợ hãi của nhân vật thông qua kinh nghiệm sống',
    Step2: 'Biến thiết lập thành một con người sống động có khuyết điểm, có sự tương phản',
    Step3: 'Tích hợp 3 bước trước, tạo ra yaml thẻ nhân vật chính hoàn chỉnh',
    Step4: 'Viết hồ sơ bổ sung NSFW độc lập cho nhân vật chính',
    Step5: 'Sáng tác thiết lập cho nhân vật phụ/NPC (có thể tạo ra nhiều vòng)',
    Step6: 'Cô đọng mục xem lướt nhân vật và các mối quan hệ',
    Step7: 'Xác định cần những phân tích tự động nào trong giai đoạn trò chơi',
    Step8: 'Viết prompt cho các nhiệm vụ phân tích (có thể tạo ra nhiều vòng)',
    StepX: 'Kiểm tra tính nhất quán và chất lượng của các sản phẩm hiện có (Bước công cụ, sử dụng khi cần)',
    Overview: 'Xác nhận đã hoàn thành toàn bộ, xuất yaml thu dọn để kích hoạt dọn dẹp cuối cùng',
};
for (const step of steps) {
    step.brief = ROADMAP_BRIEFS[step.id] || step.name;
}

// Tổng quan (Thu dọn): Chỉ đến bằng cách thủ công; Sau khi Ruby trả về yaml chứa "Người chơi đã hoàn thành", sẽ kích hoạt dọn dẹp cuối cùng
steps.push({
    id: 'Overview',
    name: 'Tổng quan',
    optional: false,
    tool: true,
    instruction: [
        'Người sáng tạo đã bày tỏ rõ ràng: Toàn bộ ý tưởng viết thẻ đã hoàn thành, bước vào giai đoạn thu dọn.',
        '',
        'Nhiệm vụ của bạn:',
        '1. Xem lại toàn bộ sản phẩm của cuộc trò chuyện viết thẻ lần này (Tư duy thẩm mỹ, Khám phá linh hồn, Xây dựng nhân vật sống động, Thẻ nhân vật, Hồ sơ NSFW, NPC, Xem lướt nhân vật, Prompt phân tích, v.v.).',
        '2. Xuất một khối code yaml làm tóm tắt thu dọn, định dạng như sau:',
        '',
        '<ruby_overview>',
        '```yaml',
        'Trạng thái: Người chơi đã hoàn thành',
        'Danh sách sản phẩm:',
        '  Thiết lập thẩm mỹ: [Một câu giải thích cốt lõi của tư duy thẩm mỹ lần này]',
        '  Thiết lập nhân vật: [Tên nhân vật chính + một câu]',
        '  Thiết lập NSFW: [Nếu có, một câu; nếu không có viết "Chưa tạo"]',
        '  Prompt phân tích: [Danh sách các nhiệm vụ phân tích được tạo lần này]',
        'Giải thích lưu giữ: [Một câu thông báo cho người sáng tạo rằng các thiết lập trên sẽ được giữ lại trong worldbook, các mục quá trình còn lại sẽ bị dọn dẹp]',
        '```',
        '</ruby_overview>',
        '',
        'Yêu cầu nghiêm ngặt:',
        '- Phải xuất khối code yaml trên và dòng "Trạng thái: Người chơi đã hoàn thành" không được thay đổi (Đây là mỏ neo để RUBY nhận diện việc thu dọn).',
        '- Không xuất bài văn chia tay dài dòng, ngoài yaml ra tối đa chỉ một hai câu thu dọn.',
        '- Đây là bước thu dọn, không mở ra cuộc thảo luận sáng tác mới nữa.',
        '- Cấm sử dụng thẻ <ruby_overview> trong lúc thảo luận bình thường, nó chỉ được xuất một lần khi thu dọn.',
    ].join('\n'),
    guide: [
        '<details>',
        '<summary><big><b style="color:#e67e22">Tổng quan: Thu dọn viết thẻ</b></big></summary>',
        '',
        '```',
        'Bước này là điểm kết thúc của toàn bộ quy trình viết thẻ, chỉ có thể vào thủ công.',
        '',
        'Sau khi vào hãy nói với Ruby: Bạn đã hoàn thành ý tưởng của mình rồi.',
        'Ruby sẽ xuất một tóm tắt thu dọn yaml chứa "Trạng thái: Người chơi đã hoàn thành".',
        '',
        'Sau khi RUBY phát hiện dấu hiệu này sẽ tự động thực hiện dọn dẹp cuối cùng:',
        '  Giữ lại: Thiết lập thẩm mỹ, Thiết lập nhân vật, Thiết lập NSFW, Thiết lập NPC,',
        '        Xem lướt nhân vật, Prompt phân tích',
        '  Xóa bỏ: Các mục quá trình còn lại (Khám phá linh hồn, Sống động hóa, Kế hoạch phân tích, v.v.',
        '        Bản nháp và toàn bộ mục tiêm của các bước)',
        '```',
        '',
        '</details>',
    ].join('\n'),
});

const data = {
    version: 1,
    draftBook: 'Bản nháp viết thẻ ruby',
    rules: read('00_角色创作步骤辅助规则.txt'),
    persona: read('01_Ruby写卡助手.txt'),
    appendix: read('17_附录_分析器原理知识库.txt'),
    steps,
};

const out = `// Tự động tạo: tools/build-cardwriter-data.mjs —— Vui lòng không sửa thủ công, hãy chạy lại script để cập nhật
// Thư mục nguồn: Worldbook/Bộ phân tích chung/Mục RUBY
export const CARDWRITER_DATA = ${JSON.stringify(data, null, 2)};
`;

const outPath = join(repoRoot, 'src', 'cardwriter-data.js');
writeFileSync(outPath, out, 'utf8');
const kb = (out.length / 1024).toFixed(1);
console.log(`written: src/cardwriter-data.js (${kb} KB), steps: ${steps.length}`);