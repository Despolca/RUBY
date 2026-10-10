import * as config from './config.js';
import { refreshVisibility } from './orb.js';
import { openPanel } from './panel.js';
import { ctx, warn, h } from './env.js';

const DRAWER_ID = 'ruby_analyzer_ext_settings';

// ---------- Chủ đề chế độ ban đêm ----------
// Tông màu chủ đạo: Gắn class .ruby-dark vào body / html, toàn bộ style ghi đè tập trung ở style.css.

/** Có đang ở chế độ ban đêm hay không: Khi ui.darkMode rõ ràng là true/false thì theo lựa chọn của người dùng, nếu không thì theo giao diện hệ thống */
export function isDarkMode() {
    const ui = config.getUi();
    if (ui && (ui.darkMode === true || ui.darkMode === false)) return ui.darkMode;
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
        return false;
    }
}

/** Áp dụng chủ đề: Chuyển đổi class body.ruby-dark (Toàn bộ style của component được điều khiển từ đây) */
export function applyTheme() {
    const dark = isDarkMode();
    document.body.classList.toggle('ruby-dark', dark);
    document.documentElement.classList.toggle('ruby-dark', dark);
}

/** Khởi động chủ đề: Áp dụng ngay + lắng nghe thay đổi cấu hình UI; Khi chưa thiết lập thủ công thì chuyển đổi theo thời gian thực dựa trên giao diện hệ thống */
export function initTheme() {
    applyTheme();
    window.addEventListener('ruby:ui-changed', applyTheme);
    try {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onSystemChange = () => {
            const ui = config.getUi();
            if (ui && (ui.darkMode === true || ui.darkMode === false)) return;
            applyTheme();
        };
        if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemChange);
        else if (typeof media.addListener === 'function') media.addListener(onSystemChange);
    } catch { /* Bỏ qua đối với trình duyệt cũ */ }
}

/**
 * Ngăn kéo RUBY trong thanh cài đặt tiện ích mở rộng của Tavern (bảng _EXTENSIONS):
 * Công tắc hiển thị quả cầu nổi + thanh kéo kích thước + lối vào bảng điều khiển. ST ủy quyền xử lý gập mở .inline-drawer-toggle toàn cục.
 */
export function initSettingsDrawer() {
    if (document.getElementById(DRAWER_ID)) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;

    const drawer = document.createElement('div');
    drawer.className = 'extension_container';
    drawer.id = DRAWER_ID;
    drawer.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>RUBY Analyzer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="ruby_ext_orb_toggle" type="checkbox">
                    <span>Hiển thị quả cầu nổi</span>
                </label>
                <div class="ra-ext-row">
                    <span>Kích thước quả cầu nổi <span id="ruby_ext_orb_size_val">60</span>px</span>
                    <input id="ruby_ext_orb_size" type="range" min="32" max="60" step="2" style="flex:1;max-width:170px;">
                </div>
                <div class="ra-ext-tip">Kéo thanh trượt sang trái để thu nhỏ quả cầu nổi (Hiện tại 60px là tối đa); Sau khi tắt quả cầu nổi vẫn có thể dùng lệnh <code>/ruby</code> để mở bảng điều khiển</div>
                <label class="checkbox_label">
                    <input id="ruby_ext_dark_toggle" type="checkbox">
                    <span>Chế độ ban đêm</span>
                </label>
                <div class="ra-ext-tip">Mặc định theo giao diện hệ thống, sau khi chuyển đổi thủ công sẽ ghi nhớ lựa chọn của bạn; Góc trên bên phải bảng điều khiển cũng có nút chuyển đổi 🌙/☀️</div>
                <div class="ra-ext-divider"></div>
                <div class="ra-cb-section">
                    <div class="ra-cb-head">
                        <b>📖 Worldbook chat phân tích nhân vật đã tạo</b>
                        <button id="ruby_ext_cb_refresh" class="ra-cb-refresh" title="Làm mới danh sách">🔄</button>
                    </div>
                    <div class="ra-ext-tip">Các worldbook chat do bộ phân tích nhân vật ghi vào khi chơi sẽ tự động được đăng ký tại đây, phân nhóm theo thẻ nhân vật (mặc định thu gọn). Nhấp vào tên sách để mở worldbook tương ứng; ✕ Chỉ xóa khỏi danh sách (không xóa worldbook).</div>
                    <div id="ruby_ext_cb_list" class="ra-cb-list"></div>
                </div>
            </div>
        </div>`;

    host.appendChild(drawer);

    const toggle = drawer.querySelector('#ruby_ext_orb_toggle');
    toggle.checked = !config.getUi().orbHidden;
    toggle.addEventListener('change', () => {
        config.saveUi({ orbHidden: !toggle.checked });
        refreshVisibility();
        window.dispatchEvent(new CustomEvent('ruby:ui-changed'));
    });

    // Thanh kéo kích thước: Xem trước tức thì, lưu khi thay đổi
    const sizeInput = drawer.querySelector('#ruby_ext_orb_size');
    const sizeVal = drawer.querySelector('#ruby_ext_orb_size_val');
    const applySizeFromInput = () => {
        const size = config.clampOrbSize(sizeInput.value);
        sizeInput.value = size;
        sizeVal.textContent = size;
        config.saveUi({ orbSize: size });
        window.dispatchEvent(new CustomEvent('ruby:ui-changed'));
    };
    sizeInput.value = config.clampOrbSize(config.getUi().orbSize);
    sizeVal.textContent = sizeInput.value;
    sizeInput.addEventListener('input', applySizeFromInput);

    // Công tắc chế độ ban đêm: Đánh dấu = bắt buộc ban đêm, bỏ đánh dấu = bắt buộc ban ngày (ghi vào ui.darkMode, không còn theo hệ thống)
    const darkToggle = drawer.querySelector('#ruby_ext_dark_toggle');
    if (darkToggle) {
        darkToggle.checked = isDarkMode();
        darkToggle.addEventListener('change', () => {
            config.saveUi({ darkMode: !!darkToggle.checked });
            window.dispatchEvent(new CustomEvent('ruby:ui-changed'));
        });
    }

    // Sau khi bảng điều khiển lưu cấu hình UI thì đồng bộ trạng thái công tắc và thanh kéo
    window.addEventListener('ruby:ui-changed', () => {
        const el = document.getElementById('ruby_ext_orb_toggle');
        if (el) el.checked = !config.getUi().orbHidden;
        const sz = document.getElementById('ruby_ext_orb_size');
        const szVal = document.getElementById('ruby_ext_orb_size_val');
        const size = config.clampOrbSize(config.getUi().orbSize);
        if (sz && String(sz.value) !== String(size)) {
            sz.value = size;
            if (szVal) szVal.textContent = size;
        }
    });

    // Nhấp đúp vào tiêu đề để mở bảng điều khiển
    drawer.querySelector('.inline-drawer-header').addEventListener('dblclick', () => {
        openPanel();
    });

    // Worldbook chat phân tích nhân vật đã tạo: Render + làm mới thủ công + tự động làm mới sau khi engine đăng ký
    renderGeneratedChatBooks();
    drawer.querySelector('#ruby_ext_cb_refresh')?.addEventListener('click', () => renderGeneratedChatBooks());
    window.addEventListener('ruby:chatbooks-changed', () => renderGeneratedChatBooks());
}

// ---------- Worldbook chat phân tích nhân vật đã tạo: Render danh sách và tương tác ----------

// Ghi nhớ nhóm nhân vật người dùng đã mở rộng, giữ nguyên khi render lại (mặc định thu gọn)
const expandedCbGroups = new Set();

/** Mở worldbook được chỉ định: Mô phỏng lại logic chọn "Chat Lore" chính thức của ST (không thay đổi trạng thái kích hoạt) */
function openWorldBook(bookName) {
    if (!bookName) return;
    const jq = window.jQuery || window.$;
    try {
        if (jq) {
            if (!jq('#WorldInfo').is(':visible')) jq('#WIDrawerIcon').trigger('click');
            const names = ctx()?.getWorldInfoNames?.() || [];
            const index = names.indexOf(bookName);
            if (index >= 0) {
                jq('#world_editor_select').val(index).trigger('change');
                return;
            }
            // Hồi lui: Thuộc tính value của mục thả xuống là chỉ số, text mới là tên sách, khớp theo text
            const sel = jq('#world_editor_select');
            if (sel?.length) {
                const opt = sel.find('option').toArray().find((o) => o.textContent === bookName);
                if (opt) { sel.val(opt.value).trigger('change'); return; }
            }
        }
        window.toastr?.warning?.(`Không tìm thấy "${bookName}" trong danh sách worldbook (Có thể cuộc trò chuyện tương ứng chưa mở)`);
    } catch (e) {
        warn(`open world book failed: ${e?.message || e}`);
    }
}

/** Render sổ đăng ký: Phân nhóm theo thẻ nhân vật, mỗi nhóm có thể thu gọn (mặc định thu gọn), nhấp vào tên sách để mở */
function renderGeneratedChatBooks() {
    const list = document.getElementById('ruby_ext_cb_list');
    if (!list) return;

    const books = config.getGeneratedChatBooks();
    if (books.length === 0) {
        list.innerHTML = '<div class="ra-cb-empty">Tạm thời chưa có worldbook chat phân tích nào được tạo (Sẽ tự động đăng ký sau khi bộ phân tích ghi vào lúc chơi)</div>';
        return;
    }

    // Phân nhóm theo thẻ nhân vật: avatar là khóa ổn định, name dùng để hiển thị
    const groups = new Map();
    for (const b of books) {
        const gKey = b.characterAvatar || b.characterName || '__unknown__';
        if (!groups.has(gKey)) {
            groups.set(gKey, { name: b.characterName || 'Nhân vật không rõ', items: [] });
        }
        groups.get(gKey).items.push(b);
    }
    // Sắp xếp theo tên nhân vật; trong nhóm sắp xếp theo thời gian cập nhật giảm dần (mới nhất xếp trước)
    const sortedGroups = [...groups.entries()]
        .sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh-Hans-CN'));

    list.innerHTML = sortedGroups.map(([gKey, g]) => {
        g.items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const expanded = expandedCbGroups.has(gKey);
        const items = g.items.map((b, idx) => `
            <div class="ra-cb-item">
                <span class="ra-cb-idx">${idx + 1}.</span>
                <a class="ra-cb-link" data-book="${h(b.chatBookName)}" title="Nhấp để mở worldbook">${h(b.chatBookName)}</a>
                <button class="ra-cb-remove" data-key="${h(b.key)}" title="Xóa khỏi danh sách (Không xóa worldbook)">✕</button>
            </div>`).join('');
        return `
        <div class="ra-cb-group ${expanded ? '' : 'collapsed'}" data-group="${h(gKey)}">
            <div class="ra-cb-group-header">
                <span class="ra-cb-arrow">${expanded ? '▼' : '▶'}</span>
                <span class="ra-cb-group-name">${h(g.name)}</span>
                <span class="ra-cb-group-count">${g.items.length}</span>
            </div>
            <div class="ra-cb-group-body">${items}</div>
        </div>`;
    }).join('');

    // Thu gọn/Mở rộng (Giữ nguyên trạng thái)
    list.querySelectorAll('.ra-cb-group-header').forEach((head) => {
        head.addEventListener('click', () => {
            const group = head.closest('.ra-cb-group');
            if (!group) return;
            const gKey = group.dataset.group;
            const collapsed = group.classList.toggle('collapsed');
            head.querySelector('.ra-cb-arrow').textContent = collapsed ? '▶' : '▼';
            if (collapsed) expandedCbGroups.delete(gKey);
            else expandedCbGroups.add(gKey);
        });
    });
    // Mở worldbook
    list.querySelectorAll('.ra-cb-link').forEach((link) => {
        link.addEventListener('click', () => openWorldBook(link.dataset.book));
    });
    // Xóa khỏi danh sách
    list.querySelectorAll('.ra-cb-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.dataset.key;
            if (!key) return;
            if (!window.confirm('Xóa đăng ký này khỏi danh sách? (Sẽ không xóa bản thân worldbook)')) return;
            config.unregisterGeneratedChatBook(key);
            renderGeneratedChatBooks();
        });
    });
}