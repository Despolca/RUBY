import { ctx, log, h } from './env.js';
import * as config from './config.js';
import * as scheduler from './scheduler.js';
import * as jailbreak from './jailbreak.js';
import * as engine from './engine.js';
import * as ai from './ai.js';
import * as worldbook from './worldbook.js';
import * as cardwriter from './cardwriter.js';
import { countAiReplies, getLittleWhiteBoxSummary, getShujukuBoundary, getYuzukiStatus, getBaibaibookStatus, ordinalForIndex } from './reader.js';
import { isDarkMode } from './settings.js';
import { BUILTIN_REFERENCES, findShadowingKey } from './builtin-refs.js';
import * as director from './director.js';

const PANEL_ID = 'ra_panel';
const UI_STATE_KEY = 'ruby_analyzer_ui_state';

const $ = (id) => document.getElementById(id);
const on = (el, ev, cb) => el && el.addEventListener(ev, cb);

const ui = {
    mode: 'player',
    playerSub: 'main',
    creatorSub: 'refs',
    editingPresetId: null,
    refs: [],
    tasks: [],
    nextTaskId: 1,
    tags: [],
    jailbreakItems: [],
    scannedKeys: [],
    scanMode: false,
    refAddedCollapsed: true,
    expandedTasks: new Set(),
    collapsedJb: new Set(),
    importedTemplateName: '',
    directorViewActive: false,
    director: null,
};

let panelBuilt = false;
let interactionsBound = false;

const hashString = (input) => {
    let hash = 2166136261;
    const str = String(input || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
};

const buildAutoVarName = (entryKey, usedSet = new Set()) => {
    const key = String(entryKey || '').trim();
    let base = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) base = 'item';
    const hash = hashString(key).slice(0, 6);
    let candidate = `ref_${base}_${hash}`;
    let idx = 2;
    while (usedSet.has(candidate)) {
        candidate = `ref_${base}_${hash}_${idx++}`;
    }
    usedSet.add(candidate);
    return candidate;
};

const normalizeKeyword = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const isKeywordSimilar = (a, b) => {
    const na = normalizeKeyword(a);
    const nb = normalizeKeyword(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 2 && nb.length >= 2) {
        return na.includes(nb) || nb.includes(na);
    }
    return false;
};

function saveUIState() {
    const state = {
        mode: ui.mode,
        playerSub: ui.playerSub,
        creatorSub: ui.creatorSub,
    };
    try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function loadUIState() {
    try {
        const saved = localStorage.getItem(UI_STATE_KEY);
        return saved ? JSON.parse(saved) : null;
    } catch { return null; }
}

function withConfigData(mutator) {
    const { data } = config.resolveConfig();
    mutator(data);
    config.saveConfigData(data);
    config.flushCardPersistNow().catch(() => { /* flush nội bộ đã báo cáo lỗi */ });
}

function getEditingPreset(data) {
    const cfgData = data || config.resolveConfig().data;
    const preset = cfgData.presets.find((p) => p.id === ui.editingPresetId);
    return preset || config.getActivePreset(cfgData);
}

function activePositionsOf(task) {
    const raw = Array.isArray(task.cyclePositions) && task.cyclePositions.length > 0
        ? task.cyclePositions
        : (task.cyclePosition || task.triggerFloor ? [task.cyclePosition || task.triggerFloor] : []);
    return raw.filter((n) => n > 0);
}

/**
 * Dưới phương án kích hoạt hiện tại, thẻ nhân vật hiện tại có tồn tại nhiệm vụ bật "sẽ thực thi thực tế" hay không
 * (Bao gồm nhiệm vụ khởi đầu). Khi không có nhiệm vụ thì không nên chạm vào worldbook chat——để tránh việc vừa mở bảng
 * đã tạo ra worldbook chat RUBY rỗng.
 */
function hasRunnableTasks(data) {
    const cfgData = data || config.resolveConfig().data;
    const preset = config.getActivePreset(cfgData);
    const identity = config.getCharacterIdentity();
    if (!identity) return false;
    if (preset.startupTask?.enabled && scheduler.taskMatchesCharacter(preset.startupTask, identity)) return true;
    return (preset.tasks || []).some((t) => t.enabled && scheduler.taskMatchesCharacter(t, identity));
}

/** Chỉ tái tạo engine khi có nhiệm vụ được bật; khi không có nhiệm vụ thì duy trì chờ, tránh tạo worldbook chat */
function reinitEngineIfNeeded() {
    if (hasRunnableTasks()) {
        engine.reinit();
    } else {
        log('skip engine.reinit: Phương án hiện tại không có nhiệm vụ được bật, duy trì chờ (không tạo worldbook chat)');
    }
}

export function openPanel(mode) {
    buildPanel();
    const root = $(PANEL_ID);
    if (!root) return;
    if (mode) {
        const tab = root.querySelector(`.mode-tab[data-mode="${mode}"]`);
        if (tab) tab.click();
    }
    refreshAll();
    if (mode === 'cardwriter') renderCardWriterTab();
    root.style.display = 'flex';
}

export function closePanel() {
    const root = $(PANEL_ID);
    if (root) root.style.display = 'none';
}

export function isPanelOpen() {
    const root = $(PANEL_ID);
    return !!root && root.style.display !== 'none';
}

/** Nút chuyển đổi giao diện: 🌙=Đang ban ngày (Nhấp để sang Đêm) ☀️=Đang ban đêm (Nhấp để về Ngày) */
function updateThemeButton() {
    const btn = $('ra_theme_toggle');
    if (btn) btn.textContent = isDarkMode() ? '☀️' : '🌙';
}

function refreshAll() {
    updateThemeButton();
    const { data, layer, source } = config.resolveConfig();
    if (!ui.editingPresetId || !data.presets.some((p) => p.id === ui.editingPresetId)) {
        ui.editingPresetId = data.activePresetId || data.presets[0]?.id;
    }
    renderStatus(layer, source);
    renderPresetDisplay(data, layer);
    renderManualButtons(data, layer);
    renderSchedule(data, layer);
    checkEntryStatus(data);
    renderPresetList(data);
    loadApiTab(data);
    ui.jailbreakItems = jailbreak.getJailbreakItems(data);
    renderJailbreakItems();
    ui.tags = [...(data.customContentTags || [])];
    renderTagsList();
    renderSummaryProviders(data);
    renderSchemeTabs();
    loadSchemeToUI(ui.editingPresetId);
    ui.refs = getEditingPreset(data).referencePool ? [...getEditingPreset(data).referencePool] : [];
    renderRefPool();
    renderBindingTab(layer);
    renderPresetSummary();
}

function buildPanel() {
    if (panelBuilt && $(PANEL_ID)) return;
    if ($(PANEL_ID)) $(PANEL_ID).remove();

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.innerHTML = buildShellHtml();
    document.body.appendChild(root);
    panelBuilt = true;

    wireTabs(root);
    wireGlobalInteractions();
    wirePlayerSections();
    wireJailbreakControls();
    wireTagControls();
    wireRefPoolControls();
    wireTaskControls();
    wireDirectorControls();
    wireBindingControls();
    wirePresetIoControls();
    wireCardWriterControls(root);

    on($('ra_close'), 'click', closePanel);
    root.querySelector('.ra-mask')?.addEventListener('click', closePanel);
    on($('ra_theme_toggle'), 'click', () => {
        const next = !isDarkMode();
        config.saveUi({ darkMode: next });
        window.dispatchEvent(new CustomEvent('ruby:ui-changed'));
        updateThemeButton();
    });
    updateThemeButton();
}

function buildShellHtml() {
    return `
    <div class="ra-mask"></div>
    <div class="card">
        <div class="title-bar">
            <div>
                <h1>◆ Hệ thống Phân tích Nhân vật RUBY ◆</h1>
                <div class="subtitle">Ruby Universal Bot Yield - Tiện ích Phân tích Độc lập</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <button id="ra_theme_toggle" class="close-btn" title="Chuyển đổi chế độ Đêm/Ngày">🌙</button>
                <button id="ra_close" class="close-btn">✕ Đóng</button>
            </div>
        </div>

        <div class="mode-tabs">
            <div class="mode-tab player active" data-mode="player">🎮 Bảng Người chơi</div>
            <div class="mode-tab creator active" data-mode="creator">🛠️ Bảng Người sáng tạo</div>
            <div class="mode-tab cardwriter" data-mode="cardwriter">✍️ Viết thẻ</div>
        </div>

        <div class="body">
            <div class="panel-content active" data-panel="player">
                <div class="sub-tabs">
                    <div class="sub-tab active" data-sub="main">📊 Bảng chính</div>
                    <div class="sub-tab" data-sub="presets">🎯 Phương án cấu hình</div>
                    <div class="sub-tab" data-sub="api">⚙️ Cài đặt API</div>
                    <div class="sub-tab" data-sub="jailbreak">🧩 Vượt rào tùy chỉnh</div>
                    <div class="sub-tab" data-sub="tags">🏷️ Thẻ chính văn</div>
                    <div class="sub-tab" data-sub="summary">📋 Giao diện tóm tắt</div>
                </div>

                <div class="sub-content active" data-subcontent="main" style="padding:16px;">
                    <div class="form-section">
                        <div class="form-header red">■ Trạng thái hệ thống</div>
                        <div class="form-body"><div id="ra_status" class="status-box">Đang kiểm tra...</div></div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ Phương án cấu hình hiện tại</div>
                        <div class="form-body">
                            <div id="ra_current_preset" class="status-box" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;"></div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ Thực thi phân tích thủ công</div>
                        <div class="form-body">
                            <div id="ra_manual_buttons" style="display:flex;flex-wrap:wrap;gap:10px;"><span>Đang tải...</span></div>
                            <div class="tip">Nhấp vào nút để bắt buộc thực thi nhiệm vụ phân tích tương ứng, không bị giới hạn bởi số tầng; thực thi thủ công sẽ không làm gián đoạn chu kỳ tự động dưới nền.</div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ Lịch trình kích hoạt nhiệm vụ</div>
                        <div class="form-body">
                            <div id="ra_schedule" class="status-box">Tạm thời không có nhiệm vụ</div>
                            <div class="tip">⚠️ Số tầng chỉ tính tin nhắn phản hồi của AI, không tính tin nhắn của người dùng</div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ Kiểm tra trạng thái mục</div>
                        <div class="form-body"><div id="ra_entries" class="status-box">Đang kiểm tra...</div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="presets" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ Phương án cấu hình khả dụng</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:16px;">
                                🎯 <strong>Phương án cấu hình</strong>: Người sáng tạo có thể thiết lập sẵn nhiều bộ cấu hình nhiệm vụ khác nhau, bạn có thể chuyển đổi theo nhu cầu.<br>
                                Sau khi chuyển đổi phương án, nhiệm vụ phân tích sẽ thực thi theo thiết lập của phương án mới.
                            </div>
                            <div id="ra_preset_list" style="display:flex;flex-direction:column;gap:12px;"></div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ Chi tiết phương án hiện tại</div>
                        <div class="form-body"><div id="ra_preset_detail" class="status-box"></div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="api" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ Kênh API</div>
                        <div class="form-body">
                            <div class="form-row">
                                <span class="form-label">Chọn kênh</span>
                                <select id="ra_api_provider" class="w200">
                                    <option value="main">API chính của SillyTavern (Dùng kết nối hiện tại)</option>
                                    <option value="custom">Endpoint tương thích OpenAI tùy chỉnh</option>
                                </select>
                            </div>
                            <div class="form-row" id="ra_api_url_wrap">
                                <span class="form-label">Địa chỉ API</span>
                                <input id="ra_api_url" class="w320" placeholder="https://api.openai.com/v1 hoặc https://api.deepseek.com/beta">
                            </div>
                            <div class="form-row" id="ra_api_key_wrap">
                                <span class="form-label">Khóa API</span>
                                <input id="ra_api_key" class="w320" type="password" placeholder="Chỉ lưu cục bộ, tuyệt đối không xuất theo thẻ nhân vật">
                            </div>
                            <div class="form-row" id="ra_api_model_wrap">
                                <span class="form-label">Tên model</span>
                                <span class="form-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                                    <select id="ra_api_model_select" class="w250 hidden"></select>
                                    <input id="ra_api_model_text" class="w250" placeholder="Ví dụ: deepseek-chat / gpt-4o-mini">
                                    <button id="ra_api_connect" class="btn outline small">Kết nối/Lấy model</button>
                                </span>
                            </div>
                            <div class="form-row">
                                <span class="form-label">Tùy chọn</span>
                                <span class="form-value" style="display:flex;gap:16px;flex-wrap:wrap;">
                                    <label class="inline" id="ra_api_stream_label" title="Công tắc này chỉ điều khiển phương thức yêu cầu của endpoint tùy chỉnh; API chính có stream hay không do cơ chế riêng của SillyTavern quyết định theo backend hiện tại, RUBY không can thiệp"><input type="checkbox" id="ra_api_stream" checked> Truyền dạng stream</label>
                                    <label class="inline"><input type="checkbox" id="ra_notify" checked> Thông báo tiến độ phân tích</label>
                                    <label class="inline"><input type="checkbox" id="ra_orb_show" checked> Hiển thị quả cầu lơ lửng</label>
                                </span>
                            </div>
                            <div class="form-row" id="ra_dir_api_wrap" style="flex-direction:column;align-items:stretch;gap:8px;border:1.5px dashed #bbb;border-radius:6px;padding:10px 12px;">
                                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                                    <label class="inline" id="ra_dir_api_toggle_label" style="font-weight:700;">
                                        <input type="checkbox" id="ra_dir_api_enabled"> 🎬 API Đạo diễn độc lập
                                    </label>
                                    <span class="director-help" data-help="Đạo diễn là khâu ngốn IQ nhất trong toàn bộ hệ thống——nó phải hiểu diễn biến cốt truyện, cân nhắc mức độ ưu tiên của nhiệm vụ, lập kế hoạch nhịp độ kích hoạt. Nhiệm vụ phân tích dùng model rẻ và nhanh thì hoàn toàn không sao, nhưng đạo diễn thì khuyên dùng model có IQ cao hơn (model suy luận mạnh hơn), chất lượng lên lịch sẽ cải thiện rõ rệt. Sau khi tích chọn sẽ mặc định sao chép địa chỉ và khóa của API RUBY hiện tại, chỉ cần chọn lại model; địa chỉ/khóa cũng có thể chỉnh sửa khi cần thiết. Phương thức truyền (stream hay không) hoàn toàn tuân theo cài đặt API cơ bản của RUBY.">?</span>
                                    <span id="ra_dir_api_hint" class="hidden" style="font-size:11px;color:#C41E3A;font-weight:700;">⚠ Chế độ đạo diễn đã bật——Khuyên dùng cấu hình API đạo diễn độc lập và chọn model mạnh hơn</span>
                                </div>
                                <div id="ra_dir_api_fields" class="hidden" style="display:flex;flex-direction:column;gap:8px;">
                                    <div class="form-row" style="margin:0;">
                                        <span class="form-label">Địa chỉ API</span>
                                        <input id="ra_dir_api_url" class="w320" placeholder="Mặc định=Địa chỉ API RUBY hiện tại">
                                    </div>
                                    <div class="form-row" style="margin:0;">
                                        <span class="form-label">Khóa API</span>
                                        <input id="ra_dir_api_key" class="w320" type="password" placeholder="Mặc định=Khóa API RUBY hiện tại">
                                    </div>
                                    <div class="form-row" style="margin:0;">
                                        <span class="form-label">Tên model</span>
                                        <span class="form-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                                            <select id="ra_dir_api_model_select" class="w250 hidden"></select>
                                            <input id="ra_dir_api_model_text" class="w250" placeholder="Mặc định=Model API RUBY hiện tại">
                                            <button id="ra_dir_api_connect" class="btn outline small">Kết nối/Lấy model</button>
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div class="tip" style="margin-top:8px;">
                                💡 <strong>API chính</strong>: Thông qua <code>generateRaw</code> gốc của SillyTavern để chạy model đang kết nối, chỉ mượn kênh——<u>không tiêm prompt cài đặt sẵn</u> (prompt chính/jailbreak/thẻ nhân vật/lịch sử chat đều không đưa vào ngữ cảnh), chỉ gửi thông báo vượt rào và prompt nhiệm vụ do chính RUBY tự lắp ráp, cùng chung cơ chế với prompt im lặng của SillyTavern; tham số tạo của RUBY sẽ được ghi đè vào yêu cầu lần này theo event hook chính thức.<br>
                                💡 <strong>Endpoint tùy chỉnh</strong>: Giao diện tương thích OpenAI (DeepSeek, OpenRouter, GLM, v.v.), gửi thông qua dịch vụ <code>ChatCompletionService</code> chính thức của SillyTavern. Địa chỉ điền đến đoạn phiên bản là được (ví dụ <code>/v1</code>, <code>/beta</code>), máy chủ SillyTavern sẽ nối thêm <code>/chat/completions</code> và chuyển tiếp.<br>
                                🔒 Cả hai kênh đều ở dạng yêu cầu gốc của SillyTavern, thực thi bất đồng bộ dưới nền; khóa chỉ được lưu cục bộ trong cài đặt tiện ích, không đưa vào thẻ nhân vật, worldbook hay mẫu cấu hình.
                            </div>
                        </div>
                    </div>

                    <div class="form-section">
                        <div class="form-header red">■ Tham số tạo</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:10px;">
                                💡 <strong>Mặc định không gửi bất kỳ tham số tạo nào</strong>: API chính tiếp tục sử dụng cài đặt lấy mẫu hiện tại của SillyTavern, endpoint tùy chỉnh sử dụng giá trị mặc định của nhà cung cấp.<br>
                                Khi có nhu cầu tùy chỉnh thì tích vào công tắc bên dưới; <u>các tham số để trống vẫn sẽ không được gửi</u>.
                            </div>
                            <div class="form-row">
                                <span class="form-label">Công tắc tham số</span>
                                <label class="inline"><input type="checkbox" id="ra_gen_enable"> Bật tham số tạo tùy chỉnh</label>
                            </div>
                            <div class="form-row"><span class="form-label">Temperature</span><input id="ra_gen_temp" class="w100" type="number" step="0.01" min="0" max="2" placeholder="Không gửi"></div>
                            <div class="form-row"><span class="form-label">Top P</span><input id="ra_gen_top_p" class="w100" type="number" step="0.01" min="0.01" max="1" placeholder="Không gửi"></div>
                            <div class="form-row"><span class="form-label">Top K</span><input id="ra_gen_top_k" class="w100" type="number" step="1" min="1" placeholder="Không gửi"></div>
                            <div class="form-row"><span class="form-label">Presence Penalty</span><input id="ra_gen_pp" class="w100" type="number" step="0.01" min="-2" max="2" placeholder="Không gửi"></div>
                            <div class="form-row"><span class="form-label">Frequency Penalty</span><input id="ra_gen_fp" class="w100" type="number" step="0.01" min="-2" max="2" placeholder="Không gửi"></div>
                            <div class="form-row">
                                <span class="form-label">Mức độ suy luận</span>
                                <select id="ra_gen_effort" class="w150">
                                    <option value="">Không gửi</option>
                                    <option value="low">low</option>
                                    <option value="medium">medium</option>
                                    <option value="high">high</option>
                                </select>
                            </div>
                            <div class="btn-row" style="border-top:none;padding-top:0;">
                                <button id="ra_gen_reset" class="btn outline small">Xóa tham số (Khôi phục mặc định)</button>
                            </div>
                        </div>
                    </div>

                    <div class="tip">💡 Tham số tạo được lưu theo lớp cấu hình hiện tại (nhúng trong thẻ nhân vật/lưu tạm toàn cục); thông tin đăng nhập API chỉ được lưu cục bộ.</div>
                    <div class="btn-row"><button id="ra_api_save" class="btn red">💾 Lưu cài đặt API</button></div>
                </div>

                <div class="sub-content" data-subcontent="jailbreak" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ Thông báo vượt rào tùy chỉnh</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:12px;">
                                💡 Prompt nhiệm vụ sẽ được cố định gửi dưới dạng tin nhắn <code>user</code>. Tại đây có thể điều chỉnh thông báo vượt rào trước và sau nó, role của tin nhắn và vị trí tiêm; <code>{{taskType}}</code> sẽ tự động được thay thế bằng tên nhiệm vụ hiện tại.
                            </div>
                            <div id="ra_jailbreak_items"></div>
                            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
                                <button id="ra_jb_add" class="btn green small">➕ Thêm văn bản</button>
                                <button id="ra_jb_reset" class="btn outline small">Khôi phục mặc định</button>
                            </div>
                        </div>
                    </div>
                    <div class="btn-row">
                        <button id="ra_jb_export" class="btn green small">📤 Xuất vượt rào</button>
                        <button id="ra_jb_import" class="btn blue small">📥 Nhập vượt rào</button>
                        <button id="ra_jb_save" class="btn red">💾 Lưu cài đặt vượt rào</button>
                        <input type="file" id="ra_jb_file_input" accept=".json" style="display:none;">
                    </div>
                </div>

                <div class="sub-content" data-subcontent="tags" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ Thẻ trích xuất chính văn tùy chỉnh</div>
                        <div class="form-body">
                            <div class="form-row" style="border-bottom:none;">
                                <span class="form-label">Thêm thẻ</span>
                                <span class="form-value" style="display:flex;gap:8px;">
                                    <input id="ra_new_tag_input" class="w200" placeholder="Nhập tên thẻ (ví dụ: story, novel)">
                                    <button id="ra_add_tag_btn" class="btn green small">➕ Thêm</button>
                                </span>
                            </div>
                            <div id="ra_tags_list" style="display:flex;flex-wrap:wrap;gap:8px;min-height:40px;padding:10px;background:#f8f8f5;border:1px solid #999;border-radius:3px;margin-top:10px;"></div>
                            <div class="tip">💡 Thẻ tùy chỉnh sẽ được ưu tiên khớp trước các thẻ mặc định (content, maintext, v.v.). Sau khi thêm cần nhấp vào "Lưu thẻ" để có hiệu lực.</div>
                        </div>
                    </div>
                    <div class="btn-row"><button id="ra_tags_save" class="btn red">💾 Lưu cài đặt thẻ</button></div>
                </div>

                <div class="sub-content" data-subcontent="summary" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ Giao diện tóm tắt</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:12px;">
                                Sau khi bật, khi phân tích <strong>các tầng đã được công cụ tóm tắt tóm tắt</strong> sẽ sử dụng nội dung tóm tắt của chúng để thay thế chính văn gốc tiêm vào; các tầng mới sau ranh giới tóm tắt vẫn đọc nguyên văn. Vị trí chu kỳ, đếm số tầng, tính toán dấu trang đã đọc của từng nhiệm vụ <strong>hoàn toàn không bị ảnh hưởng</strong>.
                            </div>
                            <div id="ra_summary_providers"></div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ Nguyên lý hoạt động</div>
                        <div class="form-body">
                            <div class="status-box">
                                ① Đọc bản tóm tắt có cấu trúc do công cụ tóm tắt ghi vào metadata của chat (chỉ đọc, không sửa đổi dữ liệu tóm tắt)<br>
                                ② Dấu trang → Các tầng giữa ranh giới tóm tắt → Thay thế bằng văn bản tóm tắt (khi bật, cửa sổ đọc không còn giới hạn 20 tầng)<br>
                                ③ Ranh giới tóm tắt → Tầng mới nhất → Đọc phần tăng thêm của nguyên văn như bình thường<br>
                                ④ Giới hạn 200.000 ký tự tác dụng lên tổng thể "Tóm tắt + Chính văn mới"; việc trích dẫn mục tham khảo và đầu ra phân tích không bị ảnh hưởng<br>
                                ⑤ Chưa cài đặt công cụ tóm tắt hoặc chat hiện tại không có dữ liệu tóm tắt → Tự động lùi về chế độ thuần nguyên văn (Có thông báo trên Console)
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="panel-content" data-panel="creator">
                <div class="sub-tabs">
                    <div class="sub-tab active" data-sub="refs">📚 Kho mục tham khảo</div>
                    <div class="sub-tab" data-sub="tasks">📋 Cấu hình nhiệm vụ</div>
                    <div class="sub-tab" data-sub="binding">🔗 Ràng buộc nhân vật</div>
                    <div class="sub-tab" data-sub="preset">📦 Nhập/Xuất</div>
                    <div class="sub-tab" data-sub="help">❓ Trợ giúp</div>
                </div>

                <div class="sub-content active" data-subcontent="refs" style="padding:16px;">
                    <div class="form-section">
                        <div class="form-header blue">■ Kho mục tham khảo</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:12px;">
                                Sau khi nhấp vào "Quét Worldbook Nhân vật", tất cả các từ khóa khả dụng sẽ được liệt kê, chia thành hai nhóm: <strong>Đã thêm tham khảo</strong> (có thể thu gọn) và <strong>Chưa thêm</strong>. Đánh dấu vào các mục cần thiết và sau khi lưu, kho tham khảo chỉ giữ lại các mục đã đánh dấu, tên biến sẽ được tạo tự động.<br><br>
                                <strong>📖 Mức độ ưu tiên đọc:</strong> Ưu tiên đọc phiên bản mới nhất từ <u>Worldbook Chat</u>, nếu không có sẽ lùi về <u>Worldbook Nhân vật</u> để đọc phiên bản gốc.
                            </div>
                            <div id="ra_ref_pool_list"></div>
                            <div style="display:flex;gap:8px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px dashed #999;">
                                <button id="ra_scan_refs_btn" class="btn green">🔍 Quét Worldbook Nhân vật</button>
                                <button id="ra_refs_save" class="btn blue">💾 Lưu cấu hình kho tham khảo</button>
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ Biến tích hợp hệ thống</div>
                        <div class="form-body">
                            <div class="status-box">
                                <div><code>{{recentMessages}}</code> → Mỗi nhiệm vụ ghi lại độc lập số tầng đã đọc, lần sau chỉ đọc các tầng mới chưa đọc (bao gồm cả chính văn bị ẩn), mỗi lần tối đa 20 tầng; giới hạn chính văn một lần là <strong>200.000 ký tự</strong>, phần vượt quá ở cuối sẽ bị cắt bỏ</div>
                                <div><code>{{CHAR_NAME}}</code> → Tên nhân vật được cấu hình ở trên</div>
                                <div style="margin-top:8px;color:#333;">Biến đầu ra của nhiệm vụ: {{task_Nhiệm vụ ID_Output}} (ví dụ: {{task_1_Output}})</div>
                            </div>
                            <div class="tip" style="margin-top:8px;">
                                💡 <strong>Cơ chế đọc tăng dần</strong>: Mỗi nhiệm vụ phân tích tự duy trì "dấu trang đã đọc" riêng (Lưu trong metadata của chat).<br>
                                Mỗi lần kích hoạt chỉ đọc <u>tầng mới</u> sau lần trước (Bao gồm cả chính văn bị ẩn bởi SillyTavern), đã đọc rồi thì không đọc lại, mỗi lần đọc tối đa 20 tầng gần nhất.<br>
                                ⚠️ Khi chính văn đầu vào một lần vượt quá <strong>200.000 ký tự</strong> sẽ dừng lại, phần chính văn còn lại phía sau bị loại bỏ trực tiếp (Giữ lại phần đầu); giới hạn chỉ áp dụng cho chính văn hội thoại——các mục tham khảo và đầu ra phân tích lịch sử vẫn được giữ nguyên vẹn, tuyệt đối không bị mất do cắt xén.<br>
                                Thoát ra vào lại sẽ tiếp tục đọc từ dấu trang; chat mới sẽ đọc 20 tầng gần nhất. Dấu trang của các nhiệm vụ không ảnh hưởng lẫn nhau.
                            </div>
                        </div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="tasks" style="padding:0;display:none;">
                    <div id="ra_director_flip_bar" style="padding:10px 16px 0;display:flex;gap:8px;align-items:center;">
                        <button id="ra_director_flip" class="btn director-flip-btn director-enter" style="flex:1;padding:10px;font-size:14px;font-weight:700;">🎬 Chế độ Đạo diễn</button>
                        <span class="director-help" data-help="Chế độ Đạo diễn: Sau khi bật, Ruby với tư cách đạo diễn sẽ chạy một lần tại vị trí chu kỳ 1 (sau một phản hồi của AI), dựa theo diễn biến cốt truyện, ưu tiên nhiệm vụ và lịch sử 5 chu kỳ gần nhất để xếp lịch vị trí kích hoạt cho các nhiệm vụ phân tích trong chu kỳ này. Sau khi đạo diễn xếp lịch, vị trí chu kỳ tĩnh của các nhiệm vụ thông thường sẽ bị tiếp quản; nhiệm vụ được đạo diễn xếp trúng sẽ tự động chạy khi đến lúc (bỏ qua quét từ khóa). Nhấp vào nút bên trái để vào trang cấu hình đạo diễn.">?</span>
                    </div>
                    <div id="ra_tasks_view">
                    <div id="ra_scheme_tabs" class="scheme-tabs"></div>
                    <div id="ra_scheme_area" class="tasks-flex" style="padding:16px;">
                        <div class="scheme-header">
                            <span style="font-size:14px;">📋</span>
                            <input id="ra_scheme_name_input" placeholder="Tên phương án" value="Phương án mặc định">
                            <div class="scheme-actions">
                                <button id="ra_scheme_activate_btn" title="Đặt làm phương án người chơi đang dùng">🎯 Kích hoạt</button>
                                <button id="ra_scheme_delete_btn" class="danger" title="Xóa phương án này">🗑️ Xóa</button>
                            </div>
                        </div>
                        <div class="cycle-sticky">
                            <div class="cycle-title-row">
                                <span class="cycle-icon">🔄</span>
                                <span class="cycle-title">Dòng thời gian phân tích chu kỳ</span>
                                <span class="help-tip" data-tip="Một dòng biểu thị một chu kỳ.&#10;Vạch dọc = Nhiệm vụ sẽ kích hoạt phân tích,&#10;Vị trí = Kích hoạt ở phản hồi AI thứ mấy trong chu kỳ.&#10;Mũi tên trỏ đến cuối sẽ quay lại vị trí 1 và bắt đầu lại">?</span>
                            </div>
                            <div id="ra_cycle_timeline" class="cycle-timeline"><div class="cycle-track"></div></div>
                            <div class="cycle-status-row">
                                <span id="ra_cycle_length_badge" class="cycle-length">Độ dài chu kỳ: - phản hồi AI</span>
                                <span id="ra_cycle_counter_badge" class="cycle-counter" title="Số tầng phản hồi AI hiện tại (Tính trực tiếp từ lịch sử chat)">Phản hồi AI: -</span>
                            </div>
                        </div>
                        <div class="cycle-fold collapsed">
                            <div class="cycle-fold-header" data-cycle-fold>
                                <span class="fold-arrow">▼</span>
                                <span>📊 Chi tiết chu kỳ và thứ tự thực thi nhiệm vụ</span>
                            </div>
                            <div class="cycle-fold-body">
                                <div class="cycle-info">
                                    <div class="cycle-trigger-info">
                                        💡 <strong>Cơ chế kích hoạt (Hướng sự kiện)</strong>: Tiện ích mở rộng tự động vào chế độ nghe ngóng dưới nền sau khi tải cuộc trò chuyện, được kích hoạt bởi event gốc của SillyTavern sau khi hoàn thành mỗi phản hồi của AI.<br>
                                        Vị trí chu kỳ = ((Số tầng phản hồi AI - 1) % Độ dài chu kỳ) + 1, tính toán trực tiếp bằng hàm thuần túy, không cần biến đếm. Nếu bỏ lỡ kích hoạt sẽ tự động cộng dồn và bù đắp.
                                    </div>
                                    <div class="cycle-legend">
                                        <div class="cycle-legend-item"><span class="dot task"></span>Nhiệm vụ phân tích</div>
                                        <div class="cycle-legend-item">🔁 Vòng lặp chu kỳ</div>
                                    </div>
                                    <div id="ra_cycle_task_list" class="cycle-task-list"></div>
                                    <div class="cycle-note">
                                        💡 <strong>Giải thích chu kỳ</strong>: Độ dài chu kỳ = Vị trí chu kỳ của nhiệm vụ cuối cùng. Sau khi chu kỳ kết thúc, bộ đếm tiếp tục tăng nhưng vị trí quay lại 1.<br>
                                        📊 Biến đầu ra của mỗi nhiệm vụ có thể được tham chiếu bởi nhiệm vụ tiếp theo (Phân tích theo chu kỳ).<br>
                                        ⚠️ "Vị trí chu kỳ" của nhiệm vụ biểu thị kích hoạt ở phản hồi AI thứ mấy trong mỗi chu kỳ (Dựa trên cơ sở 1).<br>
                                        🔄 <strong>Nhiều nhiệm vụ cùng vị trí</strong>: Khi nhiều nhiệm vụ ở cùng vị trí chu kỳ, sẽ lần lượt <u>gửi yêu cầu API riêng biệt</u> để thực thi độc lập, đầu ra của nhiệm vụ trước có thể được nhiệm vụ sau tham chiếu.
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="task-scroll-area">
                            <div class="form-section">
                                <div class="form-header blue">■ Danh sách nhiệm vụ <span style="font-weight:400;font-size:12px;opacity:0.8;">(Thêm động, không giới hạn số lượng)</span></div>
                                <div class="form-body">
                                    <div class="tip" style="margin-top:0;margin-bottom:12px;">
                                        <strong>Vị trí chu kỳ</strong>: Biểu thị kích hoạt ở phản hồi AI thứ mấy trong mỗi chu kỳ (Hỗ trợ nhiều vị trí, phân tách bằng dấu phẩy, ví dụ: 5,10,15). Độ dài chu kỳ = Con số lớn nhất trong tất cả các nhiệm vụ.<br>
                                        💡 <strong>Từ khóa bổ sung</strong>: Có thể thêm từ khóa kích hoạt bổ sung cho mục đầu ra (ví dụ: tên nhân vật), hợp nhất với từ khóa của mục đầu ra.<br>
                                        📄 <strong>Sở hữu nhiệm vụ</strong>: Toàn bộ cấu hình được lưu trong thẻ nhân vật, nhiệm vụ chỉ có hiệu lực theo thẻ này, không cần chỉ định nhân vật riêng.
                                    </div>
                                    <div id="ra_task_slots"></div>
                                    <div id="ra_add_task_area" class="add-task-btn">➕ Thêm nhiệm vụ mới</div>
                                </div>
                            </div>
                        </div>
                        <div class="btn-row" style="margin-top:0;">
                            <button id="ra_tasks_reset" class="btn outline">🗑️ Xóa sạch mọi nhiệm vụ</button>
                            <button id="ra_tasks_save" class="btn blue">💾 Lưu phương án hiện tại</button>
                        </div>
                    </div>
                    </div>
                    <div id="ra_director_view" style="display:none;padding:16px;"></div>
                </div>

                <div class="sub-content" data-subcontent="binding" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header blue">■ Ràng buộc nhân vật hiện tại</div>
                        <div class="form-body">
                            <div id="ra_binding_status" class="status-box"></div>
                            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;">
                                <button id="ra_bind_btn" class="btn green">📇 Ràng buộc cấu hình vào thẻ nhân vật này</button>
                            </div>
                            <div class="tip" style="margin-top:12px;">
                                💡 <strong>Mô hình trung tâm thẻ</strong>: Cấu hình nhiệm vụ RUBY chỉ tồn tại theo thẻ nhân vật (Ghi vào trường <code>data.extensions</code> trong thẻ). Sau khi mở thẻ nhân vật, việc nhập mẫu hoặc tạo mới/sửa đổi nhiệm vụ sẽ <strong>tự động ràng buộc và ghi vào thẻ nhân vật hiện tại</strong>, xuất/chia sẻ thẻ là sẽ mang theo, nhập vào môi trường khác là có hiệu lực ngay.<br>
                                💡 <strong>Sở hữu nhiệm vụ</strong>: Toàn bộ cấu hình được lưu trong trường <code>data.extensions</code> của thẻ nhân vật, nhiệm vụ chỉ có hiệu lực theo thẻ này, không cần chỉ định nhân vật riêng cho nhiệm vụ.<br>
                                ⚠️ Khi chưa mở thẻ nhân vật, cấu hình chỉ có thể lưu tạm ở lớp toàn cục (Không xuất theo thẻ), vui lòng mở thẻ nhân vật rồi mới cấu hình; engine chỉ thực thi cấu hình của thẻ nhân vật đã được ràng buộc.<br>
                                🔒 Khóa API là biến cục bộ toàn cục, không liên quan đến việc ràng buộc, trong bất kỳ trường hợp nào cũng sẽ không bị xuất hoặc ghi vào thẻ nhân vật.
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ Danh sách nhân vật đã ràng buộc</div>
                        <div class="form-body"><div id="ra_bound_list" class="status-box"></div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="preset" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header blue">■ Nhập/Xuất mẫu cấu hình</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:16px;background:#e8f4e8;border-left-color:#2C5530;">
                                📦 <strong>Tính năng cắm-và-chạy (Plug and Play)</strong>: Xuất <strong>tất cả các phương án cấu hình</strong> thành file mẫu, để tái sử dụng nhanh chóng cho nhân vật hoặc môi trường khác.<br><br>
                                Nội dung xuất bao gồm: Tất cả các phương án cấu hình (Bao gồm kho tham khảo/nhiệm vụ khởi đầu/nhiệm vụ phân tích tương ứng của chúng), thẻ trích xuất chính văn tùy chỉnh, cài đặt vượt rào, đánh dấu phương án kích hoạt hiện tại.<br>
                                <strong>Không bao gồm</strong>: Khóa API hay bất kỳ thông tin nhạy cảm nào.
                            </div>
                            <div id="ra_preset_summary" class="status-box" style="margin-bottom:16px;"></div>
                            <div style="display:flex;gap:12px;flex-wrap:wrap;">
                                <button id="ra_preset_export" class="btn green" style="flex:1;min-width:200px;">📤 Xuất mẫu cấu hình</button>
                                <button id="ra_preset_import" class="btn blue" style="flex:1;min-width:200px;">📥 Nhập mẫu cấu hình</button>
                            </div>
                            <input type="file" id="ra_preset_file_input" accept=".json" style="display:none;">
                            <div class="tip" style="margin-top:16px;">
                                ⚠️ Việc nhập sẽ ghi vào <strong>thẻ nhân vật hiện tại</strong> và ghi đè các phương án đã có trong thẻ (Không thể nhập khi chưa mở thẻ nhân vật); các mục worldbook (Prompt, mục đầu ra) cần phải tồn tại trong worldbook nhân vật.
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ Kiểm tra nhanh</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:12px;">Sau khi nhập cấu hình, nhấp vào nút bên dưới để kiểm tra xem các mục worldbook cần thiết có tồn tại hay không.</div>
                            <button id="ra_preset_validate" class="btn outline" style="width:100%;">🔍 Kiểm tra phụ thuộc mục</button>
                            <div id="ra_validate_result" class="status-box" style="margin-top:12px;display:none;"></div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ Thông tin mẫu</div>
                        <div class="form-body"><div id="ra_template_info" class="status-box"><span style="color:#666;">Chưa tải mẫu</span></div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="help" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header blue">■ Kho mục tham khảo là gì?</div>
                        <div class="form-body">
                            <div class="status-box">
                                Kho mục tham khảo cho phép bạn đăng ký các mục worldbook cần đọc. Mỗi mục được gán một tên biến, trong prompt dùng <code>{{tên biến}}</code> để tham chiếu.<br><br>
                                <strong>Ví dụ:</strong><br>
                                • Từ khóa: Nhân vật_core → Tên biến: coreContent<br>
                                • Từ khóa: Hướng dẫn thẩm mỹ → Tên biến: aesthetics<br><br>
                                Sau đó viết trong prompt:<br>
                                <code style="display:block;margin-top:8px;padding:8px;background:#e8e8e0;">Thiết lập nhân vật tham khảo: {{coreContent}}<br>Tiêu chuẩn thẩm mỹ: {{aesthetics}}</code>
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ "Tham chiếu đầu ra của nhiệm vụ khác" là gì?</div>
                        <div class="form-body">
                            <div class="status-box">
                                Các nhiệm vụ có thể tham chiếu kết quả của nhau. Ví dụ:<br><br>
                                • Nhiệm vụ 1 (Phân tích Chuỗi suy luận) thực thi ở tầng 10, đầu ra được lưu vào {{task_1_Output}}<br>
                                • Nhiệm vụ 2 (Cập nhật SFW) thực thi ở tầng 20, có thể tích chọn tham chiếu "Đầu ra nhiệm vụ 1"<br>
                                • Trong prompt của Nhiệm vụ 2 viết {{task_1_Output}} là có thể lấy được kết quả phân tích của Nhiệm vụ 1<br><br>
                                <strong>⚠️ Lưu ý:</strong> Nhiệm vụ được tham chiếu phải thực thi trước (Vị trí chu kỳ nhỏ hơn). Nhiệm vụ cũng có thể tích chọn tham chiếu "Chính mình" (Kết quả lần trước), để thực hiện tích lũy xuyên chu kỳ.
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ Quy tắc tính số tầng</div>
                        <div class="form-body">
                            <div class="status-box">
                                <strong>Chỉ tính tin nhắn phản hồi của AI</strong>, tin nhắn của người dùng không tính vào số tầng, chính văn AI bị ẩn cũng được tính (Phân tích cần diễn biến cốt truyện đầy đủ).<br><br>
                                Ví dụ đoạn chat:<br>
                                Người dùng: Xin chào → Không tính<br>
                                AI: Chào bạn → Tầng 1<br>
                                Người dùng: Thời tiết hôm nay → Không tính<br>
                                AI: Hôm nay trời nắng → Tầng 2<br><br>
                                Nếu nhiệm vụ thiết lập vị trí chu kỳ = 10, thì sẽ kích hoạt ở phản hồi AI thứ 10 mỗi chu kỳ.
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ Hỗ trợ nhiều nhân vật / Nhiều nhiệm vụ cùng vị trí</div>
                        <div class="form-body">
                            <div class="status-box">
                                Số lượng nhiệm vụ không giới hạn, có thể kết hợp thành bất kỳ phương án lên lịch nào:<br><br>
                                • Nhiệm vụ 1: Nhân vật A - Phân tích SFW (Vị trí 5)<br>
                                • Nhiệm vụ 2: Nhân vật B - Phân tích SFW (Vị trí 5)<br>
                                • Nhiệm vụ 3: Nhân vật A - Phân tích NSFW (Vị trí 10)<br>
                                • Nhiệm vụ 4: Nhân vật B - Phân tích NSFW (Vị trí 10)<br><br>
                                <strong>🔄 Cơ chế thực thi nhiều nhiệm vụ cùng vị trí:</strong><br>
                                1. Theo thứ tự ID nhiệm vụ <u>gửi riêng biệt yêu cầu API</u> để thực thi độc lập<br>
                                2. Đầu ra của nhiệm vụ trước sẽ được cập nhật tức thì, nhiệm vụ sau có thể trực tiếp tham chiếu<br>
                                3. Sau khi hoàn thành tất cả nhiệm vụ sẽ lưu thống nhất vào Worldbook chat
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ Thông báo an toàn</div>
                        <div class="form-body">
                            <div class="status-box">
                                🔒 Khóa API chỉ được lưu trong cài đặt tiện ích của máy cục bộ (settings.json), <u>tuyệt đối không</u> ghi vào thẻ nhân vật, worldbook chat hay mẫu xuất.<br>
                                🔒 Tất cả lệnh gọi phân tích đều chạy qua kênh yêu cầu chính thức của SillyTavern (generateRaw / ChatCompletionService), do máy chủ SillyTavern chuyển tiếp ra ngoài, hình thức giống hệt với việc tạo chat bình thường, không có đặc điểm client độc lập; toàn bộ quá trình thực thi bất đồng bộ dưới nền.<br>
                                🔒 Việc cập nhật được tiến hành thông qua kênh chính thức của trình quản lý tiện ích mở rộng SillyTavern (manifest đã bật tự động cập nhật).
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="panel-content" data-panel="cardwriter">
                    <div class="sub-tabs">
                        <div class="sub-tab active" data-sub="cw-main">🖊️ Console Viết thẻ</div>
                    </div>
                    <div class="sub-content active" data-subcontent="cw-main" style="padding:16px;">
                        <div class="form-section">
                            <div class="form-header blue">■ Trạng thái chế độ viết thẻ</div>
                            <div class="form-body"><div id="ra_cw_status" class="status-box">Đang tải...</div></div>
                        </div>
                        <div class="form-section">
                            <div class="form-header blue">■ Điều khiển phiên</div>
                            <div class="form-body">
                                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                                    <button id="ra_cw_start" class="btn green">▶️ Bắt đầu phiên viết thẻ (Step0)</button>
                                    <button id="ra_cw_end" class="btn red">⏹️ Kết thúc phiên</button>
                                    <button id="ra_cw_end_clear" class="btn red">🧹 Kết thúc và dọn sạch mục viết thẻ</button>
                                    <button id="ra_cw_open_book" class="btn outline">📖 Mở 《ruby viết thẻ bản nháp》</button>
                                </div>
                                <div class="tip" style="margin-top:10px;">
                                    Sau khi bắt đầu phiên, RUBY sẽ tiêm quy tắc/thiết lập nhân vật (Độ sâu 0, sắp xếp 999 nhấn mạnh) và chỉ thị của bước hiện tại vào worldbook đính kèm của cuộc trò chuyện;
                                    bạn dùng preset và API của riêng mình để trò chuyện bình thường, RUBY chỉ lắng nghe. Sau khi phát hiện dấu hiệu hoàn thành yaml của bước đó sẽ tự động lưu nháp và chuyển sang bước tiếp theo.
                                </div>
                            </div>
                        </div>
                        <div class="form-section">
                            <div class="form-header blue">■ Quản lý bước</div>
                            <div class="form-body">
                                <div id="ra_cw_steps" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
                                <div class="tip" style="margin-top:8px;">
                                    Nhấp vào thẻ bước để chuyển đổi thủ công (Chuyển tiếp/Quay lui). ✦=Bước hiện tại. Các bước Tùy chọn/Công cụ có thể chuyển đổi theo nhu cầu.
                                </div>
                            </div>
                        </div>
                        <div class="form-section">
                            <div class="form-header blue">■ Tùy chọn viết thẻ</div>
                            <div class="form-body">
                                <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;">
                                    <label class="checkbox_label"><input type="radio" name="ra_cw_mode" value="fast" checked> ⚡ Chế độ nhanh (Tự động chuyển đổi khi phát hiện dấu hiệu hoàn thành)</label>
                                    <label class="checkbox_label"><input type="radio" name="ra_cw_mode" value="dialogue"> 💬 Chế độ đối thoại (Sẽ bật xác nhận trước khi chuyển, có thể chọn "Tôi vẫn muốn thảo luận" để tiếp tục chỉnh sửa)</label>
                                </div>
                                <label class="checkbox_label"><input id="ra_cw_draft" type="checkbox" checked> Tự động ghi vào worldbook 《ruby viết thẻ bản nháp》 khi hoàn thành</label>
                                <label class="checkbox_label"><input id="ra_cw_guide" type="checkbox" checked> Tiêm hướng dẫn bước (Tương ứng với văn bản trong bong bóng)</label>
                                <div class="tip" style="margin-top:8px;">
                                    💬 Ở chế độ đối thoại, khi phát hiện dấu hiệu hoàn thành sẽ bật hộp thoại xác nhận: Xác nhận chuyển / Tôi vẫn muốn thảo luận (Trường hợp sau sẽ tiêm một mục tạm thời "Người sáng tạo chưa hoàn toàn hài lòng, tiếp tục thảo luận", khi chuyển sang giai đoạn tiếp theo sẽ tự động xóa).<br>
                                    🧹 Vào Step4 tự động dọn dẹp các mục và bản nháp của Step1/2; Vào Step8 tự động dọn dẹp Step7; Step6.5 đã bị gỡ khỏi quy trình.<br>
                                    🏁 Sau khi hoàn thành toàn bộ, nhấp thủ công vào 「Tổng quan」 để vào khâu kết thúc: Sau khi Ruby trả về yaml chứa 「Người chơi đã hoàn thành」, sẽ tự động chỉ giữ lại cài đặt Thẩm mỹ/Nhân vật/NSFW và prompt phân tích, các mục RUBY còn lại sẽ bị xóa toàn bộ.
                                </div>
                            </div>
                        </div>
                        <div class="form-section">
                            <div class="form-header blue">■ Nhật ký hoạt động</div>
                            <div class="form-body">
                                <div id="ra_cw_log" class="status-box" style="max-height:180px;overflow-y:auto;font-size:12px;"></div>
                            </div>
                        </div>
                        <div class="form-section">
                            <div class="form-header blue">■ Nguyên lý hoạt động</div>
                            <div class="form-body">
                                <div class="status-box">
                                    ① Tiêm: Chỉ thị bước được tiêm thông qua worldbook đính kèm trò chuyện, chạy qua kênh tạo gốc của SillyTavern (preset/API của bạn), RUBY không gửi tin nhắn thay.<br>
                                    ② Lắng nghe: Sau mỗi phản hồi của AI, tiến hành phát hiện dấu hiệu hoàn thành của bước hiện tại (Khối mã yaml bọc trong XML).<br>
                                    ③ Bản nháp: Phát hiện dấu hiệu → Trích xuất yaml → Ghi vào 《ruby viết thẻ bản nháp》: Nội dung nhân vật được xếp theo thứ tự sau nhân vật (order 100+), thế giới/NPC/tóm tắt xếp trước nhân vật, prompt phân tích đưa vào mục đã đóng và thiết lập từ khóa theo tên nhân vật.<br>
                                    ④ Chuyển đổi: Mục bước hiện tại tự động đóng, mục bước tiếp theo tự động mở, tiến độ lưu trong metadata của chat (Đổi chat không bị lẫn tiến độ).<br>
                                    ⑤ Kết thúc: Bản nháp được giữ lại trong 《ruby viết thẻ bản nháp》, có thể mở bằng một cú nhấp chuột để kiểm tra.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function wireTabs(root) {
    const saved = loadUIState();
    if (saved) {
        Object.assign(ui, { mode: saved.mode || 'player', playerSub: saved.playerSub || 'main', creatorSub: saved.creatorSub || 'refs' });
    }

    const applyMode = (mode) => {
        ui.mode = mode;
        root.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
        root.querySelectorAll('.panel-content').forEach((p) => p.classList.toggle('active', p.dataset.panel === mode));
        saveUIState();
    };

    const applySub = (panelEl, sub) => {
        if (!panelEl) return;
        panelEl.querySelectorAll('.sub-tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === sub));
        panelEl.querySelectorAll('.sub-content').forEach((c) => {
            c.style.display = c.dataset.subcontent === sub ? 'block' : 'none';
        });
        if (panelEl.dataset.panel === 'creator') {
            const tasksContent = panelEl.querySelector('.sub-content[data-subcontent="tasks"]');
            if (tasksContent) {
                tasksContent.classList.toggle('tasks-fill', sub === 'tasks');
            }
        }
    };

    root.querySelectorAll('.mode-tab').forEach((tab) => {
        on(tab, 'click', () => {
            applyMode(tab.dataset.mode);
            const panelEl = root.querySelector(`.panel-content[data-panel="${tab.dataset.mode}"]`);
            applySub(panelEl, panelEl.querySelector('.sub-tab.active')?.dataset.sub || panelEl.querySelector('.sub-tab')?.dataset.sub);
            if (tab.dataset.mode === 'creator') requestAnimationFrame(() => renderCycleInfo());
            saveUIState();
        });
    });

    root.querySelectorAll('.sub-tab').forEach((tab) => {
        on(tab, 'click', () => {
            const panelEl = tab.closest('.panel-content');
            applySub(panelEl, tab.dataset.sub);
            if (panelEl.dataset.panel === 'player') ui.playerSub = tab.dataset.sub;
            else ui.creatorSub = tab.dataset.sub;
            if (tab.dataset.sub === 'tasks') requestAnimationFrame(() => renderCycleInfo());
            saveUIState();
        });
    });

    applyMode(ui.mode);
    applySub(root.querySelector('.panel-content[data-panel="player"]'), ui.playerSub);
    applySub(root.querySelector('.panel-content[data-panel="creator"]'), ui.creatorSub);
    applySub(root.querySelector('.panel-content[data-panel="cardwriter"]'), root.querySelector('.panel-content[data-panel="cardwriter"] .sub-tab')?.dataset.sub);
}

function wireGlobalInteractions() {
    if (interactionsBound) return;
    interactionsBound = true;

    document.addEventListener('click', (e) => {
        const refGroupHeader = e.target?.closest?.('.ref-group-header');
        if (refGroupHeader && !e.target.closest('.help-tip') && !e.target.closest('.ref-scan-cb')) {
            const group = refGroupHeader.closest('.ref-group');
            if (group) {
                e.preventDefault();
                group.classList.toggle('collapsed');
                if (refGroupHeader.dataset.refGroup === 'added') {
                    ui.refAddedCollapsed = group.classList.contains('collapsed');
                }
            }
            return;
        }
        const foldHeader = e.target?.closest?.('.cycle-fold-header');
        if (foldHeader) {
            e.preventDefault();
            foldHeader.closest('.cycle-fold')?.classList.toggle('collapsed');
            return;
        }
        const toggleBtn = e.target?.closest?.('.task-toggle-btn');
        if (toggleBtn) {
            e.preventDefault();
            const card = toggleBtn.closest('.task-card');
            if (!card) return;
            const id = parseInt(toggleBtn.dataset.id, 10);
            if (card.classList.contains('collapsed')) {
                card.classList.remove('collapsed');
                if (Number.isFinite(id)) ui.expandedTasks.add(id);
                toggleBtn.textContent = '▾ Cấu hình';
            } else {
                card.classList.add('collapsed');
                if (Number.isFinite(id)) ui.expandedTasks.delete(id);
                toggleBtn.textContent = '▸ Cấu hình';
            }
        }
    });

    const tipEl = document.createElement('div');
    tipEl.id = 'ra_help_tooltip';
    Object.assign(tipEl.style, {
        position: 'fixed', display: 'none', zIndex: '100000',
        background: '#333', color: '#fff', padding: '8px 12px', borderRadius: '6px',
        fontSize: '12px', lineHeight: '1.6', maxWidth: '260px', whiteSpace: 'pre-wrap',
        boxShadow: '0 4px 14px rgba(0,0,0,.4)', pointerEvents: 'none',
    });
    document.body.appendChild(tipEl);

    const showTip = (el) => {
        const txt = el.getAttribute('data-tip');
        if (!txt) return;
        tipEl.textContent = txt;
        tipEl.style.display = 'block';
        const r = el.getBoundingClientRect();
        let x = Math.round(r.left + r.width / 2 - tipEl.offsetWidth / 2);
        x = Math.max(8, Math.min(x, window.innerWidth - tipEl.offsetWidth - 8));
        let y = Math.round(r.top - tipEl.offsetHeight - 8);
        if (y < 8) y = Math.round(r.bottom + 8);
        tipEl.style.left = `${x}px`;
        tipEl.style.top = `${y}px`;
    };
    const hideTip = () => { tipEl.style.display = 'none'; };

    document.addEventListener('mouseover', (e) => {
        const el = e.target?.closest?.('.help-tip');
        if (el) showTip(el);
    });
    document.addEventListener('mouseout', (e) => {
        if (e.target?.closest?.('.help-tip')) hideTip();
    });
    document.addEventListener('touchstart', (e) => {
        const el = e.target?.closest?.('.help-tip');
        if (el) { e.preventDefault(); showTip(el); } else { hideTip(); }
    }, { passive: false });
}

async function renderStatus(layer, source) {
    const el = $('ra_status');
    if (!el) return;
    const es = engine.getEngineState();
    const identity = config.getCharacterIdentity();
    const layerText = layer === 'character'
        ? (source === 'card' ? 'Cấu hình nhúng trong thẻ nhân vật 📇' : 'Ràng buộc nhân vật (Lưu trữ cũ cục bộ)')
        : 'Toàn cục (Chưa ràng buộc thẻ nhân vật ⚠️)';

    if (!identity) {
        el.innerHTML = `
            <span class="status-warn">⚠ Chưa mở cuộc trò chuyện với nhân vật (hoặc đang ở chat nhóm), engine chờ</span><br>
            <span class="status-warn">Cấu hình RUBY được lưu trong thẻ nhân vật——vui lòng mở thẻ nhân vật rồi mới cấu hình nhiệm vụ, khi lưu sẽ tự động ràng buộc vào thẻ hiện tại</span>`;
        // '⚠ Chưa mở cuộc trò chuyện với nhân vật (hoặc đang ở chat nhóm), engine chờ'
        // 'Cấu hình RUBY được lưu trong thẻ nhân vật——vui lòng mở thẻ nhân vật rồi mới cấu hình nhiệm vụ, khi lưu sẽ tự động ràng buộc vào thẻ hiện tại'
        el.innerHTML = `
            <span class="status-warn">⚠ Chưa mở cuộc trò chuyện với nhân vật (hoặc đang ở chat nhóm), engine chờ</span><br>
            <span class="status-warn">Cấu hình RUBY được lưu trong thẻ nhân vật——vui lòng mở thẻ nhân vật rồi mới cấu hình nhiệm vụ, khi lưu sẽ tự động ràng buộc vào thẻ hiện tại</span>`;
        return;
    }

    // Khi không có nhiệm vụ được bật thì không truy vấn worldbook chat, tránh việc vừa mở bảng đã tạo worldbook rỗng
    const runnable = hasRunnableTasks();
    let chatBook = '';
    if (runnable) {
        try { chatBook = await worldbook.getChatBookName(); } catch (e) { chatBook = ''; }
    }

    const engineLine = es.armed
        ? `<span class="status-ok">🟢 Đang nghe ngóng dưới nền</span>` // '🟢 Đang nghe ngóng dưới nền'
        : (layer === 'character'
            ? '<span class="status-warn">🟡 Chờ: Lớp cấu hình hiện tại không có nhiệm vụ được bật</span>' // '🟡 Chờ: Lớp cấu hình hiện tại không có nhiệm vụ được bật'
            : '<span class="status-warn">🟡 Chờ: Cấu hình chưa được ràng buộc vào thẻ nhân vật——lưu sửa đổi sẽ tự động ghi vào thẻ hiện tại, hoặc đến trang "Ràng buộc nhân vật" để ràng buộc ngay</span>'); // '🟡 Chờ: Cấu hình chưa được ràng buộc vào thẻ nhân vật——lưu sửa đổi sẽ tự động ghi vào thẻ hiện tại, hoặc đến trang "Ràng buộc nhân vật" để ràng buộc ngay'

    const engineLineTrans = es.armed
        ? `<span class="status-ok">🟢 Đang nghe ngóng dưới nền</span>`
        : (layer === 'character'
            ? '<span class="status-warn">🟡 Chờ: Lớp cấu hình hiện tại không có nhiệm vụ được bật</span>'
            : '<span class="status-warn">🟡 Chờ: Cấu hình chưa được ràng buộc vào thẻ nhân vật——lưu sửa đổi sẽ tự động ghi vào thẻ hiện tại, hoặc đến trang "Ràng buộc nhân vật" để ràng buộc ngay</span>');

    const bookLine = chatBook
        ? `<span style="font-size:12px;color:#666;">📚Worldbook chat ràng buộc với RUBY:</span><a class="status-ok ra-chat-book-link" style="font-size:12px;cursor:pointer;text-decoration:underline;">${h(chatBook)}</a>`
        : (runnable
            ? `<span style="font-size:12px;color:#666;">📚Worldbook chat ràng buộc với RUBY:</span><span class="status-warn" style="font-size:12px;">Chưa ràng buộc</span>`
            : `<span style="font-size:12px;color:#999;">📚Worldbook chat ràng buộc với RUBY:</span><span style="font-size:12px;color:#999;">Không có nhiệm vụ được bật, sẽ không tạo</span>`);

    const bookLineTrans = chatBook
        ? `<span style="font-size:12px;color:#666;">📚Worldbook chat ràng buộc với RUBY:</span><a class="status-ok ra-chat-book-link" style="font-size:12px;cursor:pointer;text-decoration:underline;">${h(chatBook)}</a>`
        : (runnable
            ? `<span style="font-size:12px;color:#666;">📚Worldbook chat ràng buộc với RUBY:</span><span class="status-warn" style="font-size:12px;">Chưa ràng buộc</span>`
            : `<span style="font-size:12px;color:#999;">📚Worldbook chat ràng buộc với RUBY:</span><span style="font-size:12px;color:#999;">Không có nhiệm vụ được bật, sẽ không tạo</span>`);

    el.innerHTML = `
        <span class="status-ok">✓ Hệ thống đã sẵn sàng</span> (Lớp cấu hình: ${layerText} · ${h(identity.name)})<br>
        ${engineLineTrans}${es.running ? ' · <span style="color:#1E4B8E;">⚙️ Đang thực thi phân tích...</span>' : ''}<br>
        <span style="font-size:12px;color:#666;">Phản hồi AI: ${es.aiCount} tầng · Vị trí chu kỳ: ${es.position}/${es.cycleLength || '-'} ${es.lastRunSummary ? `· Lần thực thi trước: ${h(es.lastRunSummary)}` : ''}</span><br>
        ${bookLineTrans}
        ${es.lastError ? `<br><span class="status-err">Lỗi lần trước: ${h(es.lastError)}</span>` : ''}`;

    el.innerHTML = `
        <span class="status-ok">✓ Hệ thống đã sẵn sàng</span> (Lớp cấu hình: ${layerText} · ${h(identity.name)})<br>
        ${engineLineTrans}${es.running ? ' · <span style="color:#1E4B8E;">⚙️ Đang thực thi phân tích...</span>' : ''}<br>
        <span style="font-size:12px;color:#666;">Phản hồi AI: ${es.aiCount} tầng · Vị trí chu kỳ: ${es.position}/${es.cycleLength || '-'} ${es.lastRunSummary ? `· Lần thực thi trước: ${h(es.lastRunSummary)}` : ''}</span><br>
        ${bookLineTrans}
        ${es.lastError ? `<br><span class="status-err">Lỗi lần trước: ${h(es.lastError)}</span>` : ''}`;

    const bookLink = el.querySelector('.ra-chat-book-link');
    if (bookLink) on(bookLink, 'click', () => openChatBook(chatBook));
}

/** Nhấp vào worldbook chat: Đóng bảng RUBY → Mở ngăn kéo World/Lorebook → Tự động chọn worldbook chat đã ràng buộc.
 *  Tái tạo lại cài đặt openWorldInfoEditor chính thức của ST (getContext chưa xuất hàm này,
 *  nhưng khi nhấp vào nút "Chat Lore" của ST thì bên trong sẽ gọi nó). */
function openChatBook(bookName) {
    if (!bookName) return;
    closePanel();
    const jq = window.jQuery || window.$;
    if (!jq) return;
    try {
        // 1. Mở ngăn kéo WI (Nếu hiện tại chưa hiển thị)
        if (!jq('#WorldInfo').is(':visible')) {
            jq('#WIDrawerIcon').trigger('click');
        }
        // 2. Chọn worldbook cùng tên theo chỉ mục trong world_names
        const names = ctx()?.getWorldInfoNames?.() || [];
        const index = names.indexOf(bookName);
        if (index >= 0) {
            jq('#world_editor_select').val(index).trigger('change');
        }
    } catch (e) {
        console.warn('[RUBY] open chat book failed:', bookName, e?.message || e);
    }
}

function renderPresetDisplay(data, layer) {
    const el = $('ra_current_preset');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const taskCount = (preset.tasks || []).filter((t) => t.enabled).length;
    el.innerHTML = `
        <div style="flex:1;">
            <div style="font-weight:700;font-size:16px;color:#1E4B8E;">📌 ${h(preset.name || 'Phương án mặc định')}</div>
            <div style="font-size:12px;color:#666;margin-top:4px;">${taskCount > 0 ? `${taskCount} nhiệm vụ phân tích` : 'Tạm thời chưa cấu hình nhiệm vụ'}${layer !== 'character' ? ' · <span style="color:#8B4513;">⚠️ Chưa ràng buộc thẻ nhân vật</span>' : ''}</div>
        </div>
        <button class="btn outline small ra-switch-btn">🔄 Chuyển đổi phương án</button>`;
    on(el.querySelector('.ra-switch-btn'), 'click', () => {
        const panelEl = document.querySelector('.panel-content[data-panel="player"]');
        panelEl?.querySelectorAll('.sub-tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === 'presets'));
        panelEl?.querySelectorAll('.sub-content').forEach((c) => {
            c.style.display = c.dataset.subcontent === 'presets' ? 'block' : 'none';
        });
    });
}

function renderManualButtons(data, layer) {
    const el = $('ra_manual_buttons');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const identity = config.getCharacterIdentity();

    if (!identity) {
        el.innerHTML = '<span style="color:#1a1a1a;font-size:14px;">Vui lòng mở cuộc trò chuyện với nhân vật trước</span>';
        return;
    }
    if (layer !== 'character') {
        el.innerHTML = '<span class="status-warn">⚠ Cấu hình chưa được ràng buộc vào thẻ nhân vật——đến trang "Ràng buộc nhân vật" ở Bảng Người sáng tạo để ràng buộc rồi mới thực thi (lưu sửa đổi cũng sẽ tự động ràng buộc vào thẻ hiện tại)</span>';
        return;
    }

    const buttons = [];
    if (preset.startupTask?.enabled && scheduler.taskMatchesCharacter(preset.startupTask, identity)) {
        buttons.push(`<button class="btn green" data-run="startup">${h(preset.startupTask.displayName || 'Phân tích khởi đầu')}</button>`);
    }
    for (const task of preset.tasks || []) {
        if (task.enabled && scheduler.taskMatchesCharacter(task, identity)) {
            buttons.push(`<button class="btn green" data-run="task" data-id="${task.id}">${h(task.displayName || `Nhiệm vụ#${task.id}`)}</button>`);
        }
    }
    if (buttons.length > 1) {
        buttons.push(`<button class="btn blue" data-run="all">▶ Thực thi toàn bộ</button>`);
    }

    el.innerHTML = buttons.join('') || '<span style="color:#1a1a1a;font-size:14px;">Tạm thời không có nhiệm vụ được bật</span>';
    el.querySelectorAll('[data-run]').forEach((btn) => {
        on(btn, 'click', async () => {
            const kind = btn.dataset.run;
            const id = parseInt(btn.dataset.id, 10);
            closePanel();
            try {
                await engine.forceRun(kind, id);
            } catch (e) {
                window.toastr?.error?.(e.message || 'Thực thi thất bại', '', { timeOut: 6000 });
            }
        });
    });
}

function renderSchedule(data, layer) {
    const el = $('ra_schedule');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const identity = config.getCharacterIdentity();
    const lines = [];

    if (!identity) {
        el.innerHTML = '<span style="color:#1a1a1a;">Vui lòng mở cuộc trò chuyện với nhân vật trước</span>';
        return;
    }
    if (layer !== 'character') {
        el.innerHTML = '<span class="status-warn">⚠ Cấu hình chưa ràng buộc vào thẻ nhân vật, nhiệm vụ sẽ không tự động thực thi——lưu sửa đổi sẽ tự động ràng buộc vào thẻ nhân vật hiện tại</span>';
        return;
    }

    // Chế độ đạo diễn: Lịch trình kích hoạt nhiệm vụ theo dõi động kế hoạch của đạo diễn (Biểu đồ hóa, cùng nguồn với dòng thời gian của Bảng Người sáng tạo)
    const ds = engine.getEngineState()?.director;
    if (ds?.enabled) {
        const c = ctx();
        const parts = buildDirectorCycleParts(ds, c ? countAiReplies(c.chat) : 0);
        el.innerHTML = parts.waiting
            ? `<div style="text-align:center;padding:10px;color:#666;">${h(parts.waitNote)}</div>`
            : `<div style="font-size:12px;font-weight:600;color:#666;margin-bottom:6px;">${h(parts.badge)}｜${h(parts.counter)}</div>${parts.track}${parts.list}`;
        return;
    }

    if (preset.startupTask?.enabled && scheduler.taskMatchesCharacter(preset.startupTask, identity)) {
        const positions = scheduler.startupPositions(preset.startupTask).join(',');
        lines.push(`<div>📌 Vị trí <strong>${positions}</strong> → ${h(preset.startupTask.displayName || 'Phân tích khởi đầu')}</div>`);
    }
    const enabled = (preset.tasks || []).filter((t) => t.enabled && scheduler.taskMatchesCharacter(t, identity));
    enabled.sort((a, b) => (activePositionsOf(a)[0] || 0) - (activePositionsOf(b)[0] || 0));
    for (const task of enabled) {
        lines.push(`<div>📌 Vị trí <strong>${activePositionsOf(task).join(',') || '?'}</strong> → ${h(task.displayName || `Nhiệm vụ#${task.id}`)}</div>`);
    }
    el.innerHTML = lines.length ? lines.join('') : '<span style="color:#1a1a1a;">Tạm thời chưa cấu hình nhiệm vụ</span>';
}

async function checkEntryStatus(data) {
    const el = $('ra_entries');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const entries = [];
    for (const ref of preset.referencePool || []) {
        if (ref.entryKey) entries.push({ key: ref.entryKey, label: ref.label || ref.varName, type: 'Tham khảo' });
    }
    for (const task of preset.tasks || []) {
        if (task.promptKey) entries.push({ key: task.promptKey, label: `Prompt ${task.displayName || `Nhiệm vụ#${task.id}`}`, type: 'Prompt' });
    }

    if (entries.length === 0) {
        el.innerHTML = '<span style="color:#1a1a1a;">Tạm thời không có mục cấu hình nào</span>';
        return;
    }

    try {
        const charBook = await worldbook.getCharBookName();
        if (!charBook) {
            el.innerHTML = '<span class="status-warn">⚠ Không tìm thấy worldbook nhân vật</span>';
            return;
        }
        const results = [];
        for (const e of entries.slice(0, 12)) {
            const found = await worldbook.entryExists(charBook, e.key);
            results.push(`<span class="${found ? 'status-ok' : 'status-warn'}">${found ? '✓' : '⚠'} [${e.type}] ${h(e.label)}</span>`);
        }
        el.innerHTML = results.join('<br>')
            + (entries.length > 12 ? `<br><span style="color:#1a1a1a;">...còn ${entries.length - 12} mục nữa</span>` : '')
            + '<div style="margin-top:8px;font-size:12px;color:#666;">💡 Chỉ kiểm tra mục tham khảo và prompt. Mục đầu ra sẽ tự động được tạo vào worldbook chat khi thực thi phân tích, không cần tồn tại từ trước.</div>';
    } catch (e) {
        el.innerHTML = `<span class="status-err">Kiểm tra thất bại: ${h(e.message)}</span>`;
    }
}

function renderPresetList(data) {
    const el = $('ra_preset_list');
    if (!el) return;
    const presets = data.presets || [];
    const activeId = data.activePresetId;

    if (presets.length === 0) {
        el.innerHTML = '<span style="color:#666;">Tạm thời không có phương án cấu hình</span>';
        return;
    }

    el.innerHTML = presets.map((preset) => {
        const isActive = preset.id === activeId;
        const taskCount = (preset.tasks || []).filter((t) => t.enabled).length;
        return `
        <div class="preset-card ${isActive ? 'active' : ''}" data-id="${h(preset.id)}">
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:20px;">${isActive ? '✅' : '⭕'}</span>
                <div style="flex:1;">
                    <div class="preset-name ${isActive ? 'active' : ''}">${h(preset.name || 'Phương án chưa đặt tên')}</div>
                    <div class="preset-desc">${preset.description ? h(preset.description) : ''}</div>
                    <div class="preset-meta">${taskCount > 0 ? `📋 ${taskCount} nhiệm vụ phân tích` : '⚠️ Tạm thời không có nhiệm vụ'}</div>
                </div>
                ${isActive ? '<span style="background:#2C5530;color:#fff;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;">Đang sử dụng</span>' : '<span class="preset-switch-hint">Nhấp để chuyển →</span>'}
            </div>
        </div>`;
    }).join('');

    el.querySelectorAll('.preset-card').forEach((card) => {
        on(card, 'click', async () => {
            const presetId = card.dataset.id;
            if (presetId === data.activePresetId) return;
            const target = presets.find((p) => p.id === presetId);
            if (!window.confirm(`Bạn có chắc muốn chuyển sang phương án "${target?.name || presetId}" không?`)) return;
            withConfigData((d) => { d.activePresetId = presetId; });
            window.toastr?.success?.('Đã chuyển đổi phương án cấu hình');
            reinitEngineIfNeeded();
            refreshAll();
        });
    });

    renderPresetDetail(data, activeId);
}

function renderPresetDetail(data, presetId) {
    const el = $('ra_preset_detail');
    if (!el) return;
    const preset = data.presets.find((p) => p.id === presetId);
    if (!preset) {
        el.innerHTML = '<span style="color:#666;">Không tìm thấy phương án</span>';
        return;
    }
    const enabled = (preset.tasks || []).filter((t) => t.enabled)
        .sort((a, b) => (activePositionsOf(a)[0] || 0) - (activePositionsOf(b)[0] || 0));
    let html = `<div style="font-weight:700;font-size:15px;margin-bottom:10px;">📋 ${h(preset.name)}</div>`;
    for (const task of enabled) {
        html += `<div style="padding:6px 0;border-bottom:1px dashed #ddd;">📌 Vị trí ${activePositionsOf(task).join(',') || '?'} → ${h(task.displayName || `Nhiệm vụ#${task.id}`)}</div>`;
    }
    if (enabled.length === 0) html += '<div style="color:#666;padding:10px 0;">Tạm thời chưa cấu hình nhiệm vụ</div>';
    el.innerHTML = html;
}

function loadApiTab(data) {
    const apiCfg = config.getApiConfig();
    const uiCfg = config.getUi();
    const providerSel = $('ra_api_provider');
    if (!providerSel) return;

    providerSel.value = apiCfg.provider === 'custom' ? 'custom' : 'main';
    $('ra_api_url').value = apiCfg.url || '';
    $('ra_api_key').value = apiCfg.key || '';
    $('ra_api_stream').checked = apiCfg.stream !== false;
    $('ra_notify').checked = uiCfg.notify !== false;
    $('ra_orb_show').checked = !uiCfg.orbHidden;

    // API Đạo diễn độc lập (Cài đặt toàn cục phía người chơi): Đánh dấu nhắc nhở nổi bật + Cấp nước trường
    const dirApi = config.getDirectorApiConfig();
    $('ra_dir_api_enabled').checked = !!dirApi.enabled;
    $('ra_dir_api_url').value = dirApi.url || '';
    $('ra_dir_api_key').value = dirApi.key || '';
    $('ra_dir_api_model_text').value = dirApi.model || '';
    const dirModelSelect = $('ra_dir_api_model_select');
    if (Array.isArray(apiCfg.cache) && apiCfg.cache.length > 0 && dirApi.enabled) {
        dirModelSelect.innerHTML = apiCfg.cache.map((id) => `<option value="${h(id)}">${h(id)}</option>`).join('');
        if (dirApi.model) dirModelSelect.value = dirApi.model;
        else if (apiCfg.model) dirModelSelect.value = apiCfg.model;
    }
    syncDirectorApiUi();
    updateDirectorApiHighlight();

    const modelSelect = $('ra_api_model_select');
    const modelText = $('ra_api_model_text');
    if (Array.isArray(apiCfg.cache) && apiCfg.cache.length > 0) {
        modelSelect.innerHTML = apiCfg.cache.map((id) => `<option value="${h(id)}">${h(id)}</option>`).join('');
        if (apiCfg.model) modelSelect.value = apiCfg.model;
    }
    modelText.value = apiCfg.model || '';

    const gen = data.gen || {};
    $('ra_gen_temp').value = gen.temperature ?? '';
    $('ra_gen_top_p').value = gen.top_p ?? '';
    $('ra_gen_top_k').value = gen.top_k ?? '';
    $('ra_gen_pp').value = gen.presence_penalty ?? '';
    $('ra_gen_fp').value = gen.frequency_penalty ?? '';
    $('ra_gen_effort').value = gen.reasoning_effort || '';

    const genInputs = ['ra_gen_temp', 'ra_gen_top_p', 'ra_gen_top_k', 'ra_gen_pp', 'ra_gen_fp', 'ra_gen_effort'];
    const syncGenEnabled = () => {
        const enabled = !!$('ra_gen_enable').checked;
        genInputs.forEach((id) => { $(id).disabled = !enabled; });
    };
    $('ra_gen_enable').checked = gen.enabled === true;
    syncGenEnabled();
    $('ra_gen_enable').onchange = syncGenEnabled;

    const syncProviderUi = () => {
        const isCustom = providerSel.value === 'custom';
        $('ra_api_url_wrap').classList.toggle('hidden', !isCustom);
        $('ra_api_key_wrap').classList.toggle('hidden', !isCustom);
        $('ra_api_connect').classList.toggle('hidden', !isCustom);
        $('ra_api_stream_label')?.classList.toggle('hidden', !isCustom);
        const hasOptions = modelSelect.options.length > 0;
        modelSelect.classList.toggle('hidden', !isCustom || !hasOptions);
        modelText.classList.toggle('hidden', !isCustom || hasOptions);
    };
    syncProviderUi();
    providerSel.onchange = () => {
        syncProviderUi();
        if (providerSel.value === 'custom' && !$('ra_api_url').value.trim()) {
            $('ra_api_url').value = 'https://api.openai.com/v1';
        }
    };
    modelSelect.onchange = () => {
        const chosen = modelSelect.value || '';
        if (chosen) {
            config.saveApiConfig({ provider: providerSel.value, model: chosen });
            window.toastr?.success?.('Đã chọn model');
        }
    };
}

/** Mở/Thu gọn trường API Đạo diễn độc lập */
function syncDirectorApiUi() {
    const enabled = !!$('ra_dir_api_enabled')?.checked;
    $('ra_dir_api_fields')?.classList.toggle('hidden', !enabled);
}

/** Nhắc nhở nổi bật: Khi Chế độ đạo diễn được bật nhưng chưa cấu hình API Đạo diễn độc lập, vùng hộp kiểm sẽ hiển thị nhắc nhở (Khuyến khích đổi sang model có IQ cao hơn) */
function updateDirectorApiHighlight() {
    const wrap = $('ra_dir_api_wrap');
    if (!wrap) return;
    const directorEnabled = !!engine.getEngineState()?.director?.enabled;
    const configured = !!config.getDirectorApiConfig().enabled;
    const needed = directorEnabled && !configured;
    wrap.classList.toggle('director-needed', needed);
    $('ra_dir_api_hint')?.classList.toggle('hidden', !needed);
}

function wirePlayerSections() {
    on($('ra_dir_api_enabled'), 'change', (e) => {
        const enabled = e.target.checked;
        if (enabled) {
            // Mặc định sao chép địa chỉ và khóa của API RUBY hiện tại (Ngữ nghĩa sao chép-dán); Model để trống = Đi theo API RUBY
            const apiCfg = config.getApiConfig();
            if (!$('ra_dir_api_url').value.trim()) $('ra_dir_api_url').value = apiCfg.url || '';
            if (!$('ra_dir_api_key').value) $('ra_dir_api_key').value = apiCfg.key || '';
            if (!$('ra_dir_api_model_text').value.trim() && !$('ra_dir_api_model_select').value) {
                $('ra_dir_api_model_text').value = apiCfg.model || '';
            }
        }
        // Khi đánh dấu sẽ lưu trữ vĩnh viễn tất cả các trường ngay lập tức (Nếu không các giá trị sao chép chỉ tồn tại trong DOM, tải lại sẽ mất)
        config.saveDirectorApiConfig({
            enabled,
            url: $('ra_dir_api_url').value.trim(),
            key: $('ra_dir_api_key').value,
            model: $('ra_dir_api_model_text').value.trim(),
        });
        syncDirectorApiUi();
        updateDirectorApiHighlight();
        window.toastr?.success?.(enabled ? 'Đã bật API Đạo diễn độc lập (Mặc định dùng chung API RUBY hiện tại, có thể chọn lại model)' : 'Đã tắt API Đạo diễn độc lập, Đạo diễn sẽ đi theo API phân tích RUBY');
    });
    on($('ra_dir_api_url'), 'change', () => {
        config.saveDirectorApiConfig({ url: $('ra_dir_api_url').value.trim() });
    });
    on($('ra_dir_api_key'), 'change', () => {
        config.saveDirectorApiConfig({ key: $('ra_dir_api_key').value });
    });
    on($('ra_dir_api_model_text'), 'change', () => {
        config.saveDirectorApiConfig({ model: $('ra_dir_api_model_text').value.trim() });
    });
    on($('ra_dir_api_model_select'), 'change', () => {
        const chosen = $('ra_dir_api_model_select').value || '';
        if (chosen) {
            $('ra_dir_api_model_text').value = chosen;
            config.saveDirectorApiConfig({ model: chosen });
            window.toastr?.success?.('Đã chọn model đạo diễn');
        }
    });
    on($('ra_dir_api_connect'), 'click', async () => {
        const btn = $('ra_dir_api_connect');
        try {
            const apiCfg = config.getApiConfig();
            const base = $('ra_dir_api_url').value.trim() || apiCfg.url || '';
            const key = $('ra_dir_api_key').value.trim() || apiCfg.key || '';
            if (!base) { window.toastr?.warning?.('Vui lòng điền địa chỉ API trước'); return; }
            if (!key) { window.toastr?.warning?.('Vui lòng điền KEY trước'); return; }
            btn.disabled = true;
            btn.textContent = 'Đang kết nối...';
            const models = await ai.fetchModelList(base, key);
            if (!models.length) { window.toastr?.warning?.('Không lấy được model nào'); return; }
            const modelSelect = $('ra_dir_api_model_select');
            modelSelect.innerHTML = models.map((id) => `<option value="${h(id)}">${h(id)}</option>`).join('');
            const current = config.getDirectorApiConfig().model;
            modelSelect.value = models.includes(current) ? current : models[0];
            $('ra_dir_api_model_text').value = modelSelect.value;
            modelSelect.classList.remove('hidden');
            $('ra_dir_api_model_text').classList.add('hidden');
            config.saveDirectorApiConfig({ model: modelSelect.value });
            window.toastr?.success?.(`Lấy thành công: ${models.length} model`);
        } catch (e) {
            window.toastr?.error?.(e.message || 'Kết nối thất bại');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Kết nối/Lấy model';
        }
    });
    on($('ra_api_connect'), 'click', async () => {
        const btn = $('ra_api_connect');
        try {
            const base = $('ra_api_url').value.trim();
            const key = $('ra_api_key').value.trim();
            if (!base) { window.toastr?.warning?.('Vui lòng điền địa chỉ API trước'); return; }
            if (!key) { window.toastr?.warning?.('Vui lòng điền KEY trước'); return; }
            btn.disabled = true;
            btn.textContent = 'Đang kết nối...';
            const models = await ai.fetchModelList(base, key);
            if (!models.length) { window.toastr?.warning?.('Không lấy được model nào'); return; }
            const modelSelect = $('ra_api_model_select');
            modelSelect.innerHTML = models.map((id) => `<option value="${h(id)}">${h(id)}</option>`).join('');
            config.saveApiConfig({ provider: 'custom', url: base, key, cache: models, model: models[0] });
            modelSelect.value = models[0];
            modelSelect.classList.remove('hidden');
            $('ra_api_model_text').classList.add('hidden');
            window.toastr?.success?.(`Lấy thành công: ${models.length} model`);
        } catch (e) {
            window.toastr?.error?.(e.message || 'Kết nối thất bại');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Kết nối/Lấy model';
        }
    });

    on($('ra_gen_reset'), 'click', () => {
        ['ra_gen_temp', 'ra_gen_top_p', 'ra_gen_top_k', 'ra_gen_pp', 'ra_gen_fp'].forEach((id) => {
            const el = $(id);
            if (el) el.value = '';
        });
        $('ra_gen_effort').value = '';
        $('ra_gen_enable').checked = false;
        $('ra_gen_enable').onchange?.();
        window.toastr?.success?.('Đã xóa, khôi phục mặc định (Không gửi tham số tạo, đi theo cài đặt của SillyTavern/Nhà cung cấp)');
    });

    on($('ra_api_save'), 'click', () => {
        try {
            const providerSel = $('ra_api_provider');
            const modelSelect = $('ra_api_model_select');
            const isCustom = providerSel.value === 'custom';
            const hasSelectOptions = modelSelect.options.length > 0 && !modelSelect.classList.contains('hidden');
            const modelValue = isCustom ? (hasSelectOptions ? modelSelect.value : $('ra_api_model_text').value.trim()) : '';

            config.saveApiConfig({
                provider: providerSel.value,
                url: $('ra_api_url').value.trim(),
                key: $('ra_api_key').value.trim(),
                model: modelValue,
                stream: !!$('ra_api_stream').checked,
            });
            config.saveUi({
                notify: !!$('ra_notify').checked,
                orbHidden: !$('ra_orb_show').checked,
            });
            window.dispatchEvent(new CustomEvent('ruby:ui-changed'));

            const num = (id) => {
                const v = parseFloat($(id)?.value);
                return Number.isFinite(v) ? v : undefined;
            };
            withConfigData((d) => {
                d.gen = {
                    enabled: !!$('ra_gen_enable').checked,
                    temperature: num('ra_gen_temp'),
                    top_p: num('ra_gen_top_p'),
                    top_k: num('ra_gen_top_k'),
                    presence_penalty: num('ra_gen_pp'),
                    frequency_penalty: num('ra_gen_fp'),
                    reasoning_effort: $('ra_gen_effort').value || undefined,
                };
            });
            window.toastr?.success?.('Cài đặt API đã được lưu');
        } catch (e) {
            window.toastr?.error?.('Lưu thất bại: ' + e.message);
        }
    });
}

function collectJailbreakFromUI() {
    const container = $('ra_jailbreak_items');
    if (!container) return [];
    return [...container.querySelectorAll('.jailbreak-item[data-id]')].map((card, idx) => jailbreak.normalizeJailbreakItem({
        id: card.dataset.id,
        enabled: !!card.querySelector('.jb-enabled')?.checked,
        position: card.querySelector('.jb-position')?.value || 'beforeUser',
        role: card.querySelector('.jb-role')?.value || 'system',
        content: card.querySelector('.jb-content')?.value || '',
    }, idx));
}

function renderJailbreakItems() {
    const container = $('ra_jailbreak_items');
    if (!container) return;
    if (ui.jailbreakItems.length === 0) ui.jailbreakItems = jailbreak.cloneDefaultItems();

    const positionLabel = (pos) => (pos === 'beforeUser' ? 'Trước prompt nhiệm vụ' : pos === 'afterUser' ? 'Sau prompt nhiệm vụ' : 'Thêm vào cuối');
    container.innerHTML = ui.jailbreakItems.map((item, idx) => {
        const collapsed = ui.collapsedJb.has(item.id);
        const summary = item.content.trim()
            ? item.content.trim().replace(/\s+/g, ' ').slice(0, 36)
            : 'Văn bản trống';
        return `
        <div class="jailbreak-item ${collapsed ? 'collapsed' : ''}" data-id="${h(item.id)}">
            <div class="jailbreak-head" title="Nhấp để mở rộng hoặc thu gọn">
                <button type="button" class="btn outline small jb-toggle">${collapsed ? 'Mở rộng' : 'Thu gọn'}</button>
                <label class="inline"><input type="checkbox" class="jb-enabled" ${item.enabled ? 'checked' : ''}> Bật</label>
                <span class="jb-title">Đoạn ${idx + 1}</span>
                <select class="jb-position w150">
                    <option value="beforeUser" ${item.position === 'beforeUser' ? 'selected' : ''}>Trước prompt nhiệm vụ</option>
                    <option value="afterUser" ${item.position === 'afterUser' ? 'selected' : ''}>Sau prompt nhiệm vụ</option>
                    <option value="tail" ${item.position === 'tail' ? 'selected' : ''}>Thêm vào cuối</option>
                </select>
                <select class="jb-role w120">
                    <option value="system" ${item.role === 'system' ? 'selected' : ''}>system</option>
                    <option value="assistant" ${item.role === 'assistant' ? 'selected' : ''}>assistant</option>
                    <option value="user" ${item.role === 'user' ? 'selected' : ''}>user</option>
                </select>
                <span class="jailbreak-summary">${positionLabel(item.position)} / ${h(item.role)} / ${h(summary)}</span>
                <span class="jailbreak-actions">
                    <button type="button" class="btn outline small jb-up" ${idx === 0 ? 'disabled' : ''}>Lên</button>
                    <button type="button" class="btn outline small jb-down" ${idx === ui.jailbreakItems.length - 1 ? 'disabled' : ''}>Xuống</button>
                    <button type="button" class="btn red small jb-delete">Xóa</button>
                </span>
            </div>
            <div class="jailbreak-body">
                <textarea class="jb-content" placeholder="Điền văn bản vượt rào; có thể dùng {{taskType}} để biểu thị tên nhiệm vụ hiện tại">${h(item.content)}</textarea>
            </div>
        </div>`;
    }).join('');

    const syncFromDom = () => { ui.jailbreakItems = collectJailbreakFromUI(); };
    container.querySelectorAll('.jb-enabled,.jb-position,.jb-role,.jb-content').forEach((el) => {
        on(el, 'change', syncFromDom);
        on(el, 'input', syncFromDom);
    });

    const toggleCard = (card) => {
        const id = card.dataset.id;
        const willCollapse = !card.classList.contains('collapsed');
        card.classList.toggle('collapsed', willCollapse);
        if (willCollapse) ui.collapsedJb.add(id);
        else ui.collapsedJb.delete(id);
        card.querySelector('.jb-toggle').textContent = willCollapse ? 'Mở rộng' : 'Thu gọn';
    };

    container.querySelectorAll('.jailbreak-head').forEach((head) => {
        on(head, 'click', (e) => {
            if (e.target?.closest?.('select,input,button,label,.inline,.jailbreak-actions')) return;
            toggleCard(head.closest('.jailbreak-item'));
        });
    });
    container.querySelectorAll('.jb-toggle').forEach((btn) => {
        on(btn, 'click', (e) => {
            e.stopPropagation();
            toggleCard(btn.closest('.jailbreak-item'));
        });
    });
    container.querySelectorAll('.jb-up').forEach((btn) => {
        on(btn, 'click', () => {
            ui.jailbreakItems = collectJailbreakFromUI();
            const idx = [...container.querySelectorAll('.jailbreak-item')].indexOf(btn.closest('.jailbreak-item'));
            if (idx > 0) {
                [ui.jailbreakItems[idx - 1], ui.jailbreakItems[idx]] = [ui.jailbreakItems[idx], ui.jailbreakItems[idx - 1]];
                renderJailbreakItems();
            }
        });
    });
    container.querySelectorAll('.jb-down').forEach((btn) => {
        on(btn, 'click', () => {
            ui.jailbreakItems = collectJailbreakFromUI();
            const idx = [...container.querySelectorAll('.jailbreak-item')].indexOf(btn.closest('.jailbreak-item'));
            if (idx >= 0 && idx < ui.jailbreakItems.length - 1) {
                [ui.jailbreakItems[idx], ui.jailbreakItems[idx + 1]] = [ui.jailbreakItems[idx + 1], ui.jailbreakItems[idx]];
                renderJailbreakItems();
            }
        });
    });
    container.querySelectorAll('.jb-delete').forEach((btn) => {
        on(btn, 'click', () => {
            ui.jailbreakItems = collectJailbreakFromUI();
            const idx = [...container.querySelectorAll('.jailbreak-item')].indexOf(btn.closest('.jailbreak-item'));
            if (idx >= 0) {
                ui.jailbreakItems.splice(idx, 1);
                renderJailbreakItems();
            }
        });
    });
}

function wireJailbreakControls() {
    on($('ra_jb_add'), 'click', () => {
        ui.jailbreakItems = collectJailbreakFromUI();
        const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ui.jailbreakItems.push(jailbreak.normalizeJailbreakItem({ id, enabled: true, position: 'beforeUser', role: 'system', content: '' }, ui.jailbreakItems.length));
        ui.collapsedJb.delete(id);
        renderJailbreakItems();
    });

    on($('ra_jb_reset'), 'click', () => {
        if (!window.confirm('Bạn có chắc chắn muốn khôi phục cấu hình vượt rào mặc định không? Các thay đổi chưa lưu hiện tại sẽ bị ghi đè.')) return;
        ui.jailbreakItems = jailbreak.cloneDefaultItems();
        ui.collapsedJb.clear();
        renderJailbreakItems();
        window.toastr?.success?.('Đã khôi phục cấu hình vượt rào mặc định, vui lòng nhấp vào Lưu để có hiệu lực');
    });

    on($('ra_jb_save'), 'click', () => {
        ui.jailbreakItems = collectJailbreakFromUI();
        withConfigData((d) => {
            d.jailbreak = { items: ui.jailbreakItems };
        });
        window.toastr?.success?.('Cài đặt vượt rào đã được lưu');
    });

    on($('ra_jb_export'), 'click', () => {
        try {
            ui.jailbreakItems = collectJailbreakFromUI();
            const exportData = {
                _meta: {
                    type: 'RUBY_JAILBREAK',
                    version: '1.0.0',
                    exportTime: new Date().toISOString(),
                    description: 'Cấu hình vượt rào do Hệ thống Phân tích RUBY xuất ra (Chỉ chứa thông báo vượt rào tùy chỉnh)',
                    itemCount: ui.jailbreakItems.length,
                },
                jailbreak: jailbreak.normalizeJailbreakConfig({ items: ui.jailbreakItems }),
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ruby_jailbreak_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            window.toastr?.success?.(`Cấu hình vượt rào đã được xuất (${ui.jailbreakItems.length} mục)`);
        } catch (e) {
            window.toastr?.error?.('Xuất thất bại: ' + e.message);
        }
    });

    on($('ra_jb_import'), 'click', () => {
        $('ra_jb_file_input')?.click();
    });

    on($('ra_jb_file_input'), 'change', async (e) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const raw = JSON.parse(text);
            // Tương thích với nhiều nguồn: Xuất riêng vượt rào / Mẫu cấu hình hoàn chỉnh / Dạng {items} trần / Dạng mảng trần
            let jbRaw;
            if (raw && raw._meta?.type === 'RUBY_JAILBREAK') {
                jbRaw = raw.jailbreak;
            } else if (raw && raw._meta?.type === 'RUBY_ANALYZER_PRESET') {
                jbRaw = raw.jailbreak;
            } else if (raw && Array.isArray(raw.items)) {
                jbRaw = raw;
            } else if (Array.isArray(raw)) {
                jbRaw = { items: raw };
            } else {
                throw new Error('Không thể nhận dạng định dạng cấu hình vượt rào');
            }
            const normalized = jailbreak.normalizeJailbreakConfig(jbRaw);
            const count = normalized.items.length;
            if (!window.confirm(`Bạn có chắc chắn muốn nhập cấu hình vượt rào từ "${file.name}" không? (Tổng cộng ${count} tin nhắn) Sau khi nhập sẽ ghi đè danh sách vượt rào hiện tại và lưu ngay lập tức.`)) return;

            ui.jailbreakItems = normalized.items;
            ui.collapsedJb.clear();
            renderJailbreakItems();
            withConfigData((d) => {
                d.jailbreak = { items: ui.jailbreakItems };
            });
            window.toastr?.success?.(`Cấu hình vượt rào đã được nhập (${count} mục)`);
        } catch (err) {
            window.toastr?.error?.('Nhập thất bại: ' + err.message);
        } finally {
            e.target.value = '';
        }
    });
}

function renderTagsList() {
    const el = $('ra_tags_list');
    if (!el) return;
    if (ui.tags.length === 0) {
        el.innerHTML = '<span style="color:#1a1a1a;font-size:14px;">Tạm thời chưa có thẻ tùy chỉnh</span>';
        return;
    }
    el.innerHTML = ui.tags.map((tag, idx) => `
        <span class="custom-tag">&lt;${h(tag)}&gt;<button data-idx="${idx}" title="Xóa">✕</button></span>
    `).join('');
    el.querySelectorAll('.custom-tag button').forEach((btn) => {
        on(btn, 'click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            if (!isNaN(idx) && idx >= 0 && idx < ui.tags.length) {
                const removed = ui.tags.splice(idx, 1)[0];
                renderTagsList();
                window.toastr?.info?.(`Đã gỡ bỏ thẻ: <${removed}>`);
            }
        });
    });
}

function wireTagControls() {
    const addTag = () => {
        const tag = $('ra_new_tag_input')?.value.trim().toLowerCase();
        if (!tag) { window.toastr?.warning?.('Vui lòng nhập tên thẻ'); return; }
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(tag)) {
            window.toastr?.warning?.('Tên thẻ chỉ được chứa chữ cái, chữ số, dấu gạch dưới và dấu gạch ngang');
            return;
        }
        if (ui.tags.includes(tag)) { window.toastr?.warning?.('Thẻ đã tồn tại'); return; }
        ui.tags.push(tag);
        $('ra_new_tag_input').value = '';
        renderTagsList();
        window.toastr?.success?.(`Đã thêm thẻ: <${tag}>`);
    };
    on($('ra_add_tag_btn'), 'click', addTag);
    on($('ra_new_tag_input'), 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    });
    on($('ra_tags_save'), 'click', () => {
        withConfigData((d) => { d.customContentTags = [...ui.tags]; });
        window.toastr?.success?.('Cài đặt thẻ đã được lưu');
    });
}

// ---------- Giao diện tóm tắt (Bảng Người chơi) ----------

const SUMMARY_PROVIDERS = [
    {
        id: 'littlewhitebox',
        name: 'Tóm tắt cốt truyện Tiểu Bạch x (LittleWhiteBox)',
        description: 'Đọc bản tóm tắt có cấu trúc (sự kiện/nhân vật/sự thật/giai đoạn cốt truyện) do module tóm tắt câu chuyện Tiểu Bạch x ghi vào metadata của chat, các tầng đã được tóm tắt sẽ dùng tóm tắt thay thế nguyên văn.',
    },
    {
        id: 'shujuku',
        name: 'Tóm tắt bảng SP·Cơ sở dữ liệu',
        description: 'Đọc các mục có thể đọc (bảng tóm tắt/nhân vật quan trọng/đại cương cốt truyện) do SP·Cơ sở dữ liệu ghi vào worldbook, các tầng đã được xử lý bằng bảng sẽ dùng nội dung cơ sở dữ liệu thay thế nguyên văn.',
    },
    {
        id: 'yuzuki',
        name: 'Tóm tắt bảng ký ức Yuzuki (yuzuki-Memory)',
        description: 'Đọc bảng tóm tắt ký ức (tiêu đề tóm tắt/nhân vật cốt lõi/số tầng/nội dung tóm tắt/vấn đề chưa giải quyết) do yuzuki-Memory ghi vào metadata của chat, các tầng đã được tóm tắt sẽ dùng tóm tắt thay thế nguyên văn; dòng thời gian tóm tắt cốt truyện có thể được tiêm vào cùng lúc.',
    },
    {
        id: 'baibaibook',
        name: 'Bản ghi nhanh ký ức Bách Bảo Thư (BaiBaiBook)',
        description: 'Đọc bản ghi nhanh có cấu trúc (trạng thái/nhân vật chính/NPC kèm độ hảo cảm/vật phẩm/kế hoạch/cảnh vật/hồ sơ đời sống, v.v.) từ engine ký ức Bách Bảo Thư, các tầng đã được tóm tắt sẽ dùng nội dung bản ghi nhanh thay thế nguyên văn.',
    },
];

function renderSummaryProviders(data) {
    const el = $('ra_summary_providers');
    if (!el) return;
    const enabled = data.summaryProvider || '';

    el.innerHTML = SUMMARY_PROVIDERS.map((p) => {
        const isOn = enabled === p.id;
        let statusHtml = '';
        if (p.id === 'littlewhitebox') {
            const lwb = getLittleWhiteBoxSummary();
            if (lwb) {
                const c = ctx();
                const boundaryOrdinal = ordinalForIndex(c?.chat || [], lwb.boundary);
                const totalFloors = countAiReplies(c?.chat || []);
                statusHtml = `<div style="font-size:12px;color:#666;margin-top:8px;">
                    ✅ Đã phát hiện dữ liệu tóm tắt: Đã tóm tắt đến tầng <strong>${boundaryOrdinal}</strong> (Tổng cộng ${totalFloors} tầng) · ${lwb.facts.length} sự thật nhân vật · ${lwb.events.length} sự kiện · ${lwb.characters.length} nhân vật chính
                </div>`;
            } else {
                statusHtml = `<div style="font-size:12px;color:#8B4513;margin-top:8px;">
                    ⚠️ Chat hiện tại chưa phát hiện dữ liệu tóm tắt Tiểu Bạch x (Chưa cài đặt Tiểu Bạch x, hoặc chat này chưa chạy tóm tắt). Sau khi bật, phân tích sẽ tạm thời lùi về chế độ thuần nguyên văn, sẽ tự động có hiệu lực sau khi phát hiện dữ liệu tóm tắt.
                </div>`;
            }
        } else if (p.id === 'shujuku') {
            const boundaryIdx = getShujukuBoundary();
            if (boundaryIdx >= 0) {
                const c = ctx();
                const boundaryOrdinal = ordinalForIndex(c?.chat || [], boundaryIdx);
                const totalFloors = countAiReplies(c?.chat || []);
                statusHtml = `<div style="font-size:12px;color:#666;margin-top:8px;">
                    ✅ Đã phát hiện hoạt động cơ sở dữ liệu: Bảng đã được cập nhật đến tầng <strong>${boundaryOrdinal}</strong> (Tổng cộng ${totalFloors} tầng). Mục bảng tóm tắt/nhân vật/đại cương sẽ được đọc từ worldbook nhân vật và chat khi phân tích.
                </div>`;
            } else {
                statusHtml = `<div style="font-size:12px;color:#8B4513;margin-top:8px;">
                    ⚠️ Chat hiện tại chưa phát hiện bản ghi cập nhật bảng của SP·Cơ sở dữ liệu (Chưa cài đặt, hoặc chat này chưa từng chạy điền bảng). Sau khi bật, phân tích sẽ tạm thời lùi về chế độ thuần nguyên văn, sẽ tự động có hiệu lực sau khi phát hiện dữ liệu.
                </div>`;
            }
        } else if (p.id === 'yuzuki') {
            const yz = getYuzukiStatus();
            if (yz) {
                const c = ctx();
                const boundaryOrdinal = ordinalForIndex(c?.chat || [], yz.boundary);
                const totalFloors = countAiReplies(c?.chat || []);
                statusHtml = `<div style="font-size:12px;color:#666;margin-top:8px;">
                    ✅ Đã phát hiện tóm tắt ký ức: ${yz.records} bản ghi tóm tắt, bao phủ đến tầng <strong>${boundaryOrdinal}</strong> (Tổng cộng ${totalFloors} tầng). Nội dung tóm tắt sẽ được đọc từ metadata của chat khi phân tích.
                </div>`;
            } else {
                statusHtml = `<div style="font-size:12px;color:#8B4513;margin-top:8px;">
                    ⚠️ Chat hiện tại chưa phát hiện dữ liệu bảng ký ức Yuzuki (Chưa cài đặt yuzuki-Memory, hoặc chat này chưa tạo tóm tắt ký ức). Sau khi bật, phân tích sẽ tạm thời lùi về chế độ thuần nguyên văn, sẽ tự động có hiệu lực sau khi phát hiện dữ liệu.
                </div>`;
            }
        } else if (p.id === 'baibaibook') {
            const bbb = getBaibaibookStatus();
            if (bbb) {
                const c = ctx();
                const boundaryOrdinal = ordinalForIndex(c?.chat || [], bbb.boundary);
                const totalFloors = countAiReplies(c?.chat || []);
                statusHtml = `<div style="font-size:12px;color:#666;margin-top:8px;">
                    ✅ Đã phát hiện bản ghi nhanh ký ức: Bản sửa đổi ${bbb.revision}, bao phủ đến tầng <strong>${boundaryOrdinal}</strong> (Tổng cộng ${totalFloors} tầng). Nội dung bản ghi nhanh sẽ được đọc từ API toàn cục của Bách Bảo Thư khi phân tích.
                </div>`;
            } else {
                statusHtml = `<div style="font-size:12px;color:#8B4513;margin-top:8px;">
                    ⚠️ Chat hiện tại chưa phát hiện dữ liệu ký ức Bách Bảo Thư (Chưa cài đặt Bách Bảo Thư, hoặc chat này chưa tạo tóm tắt ký ức). Sau khi bật, phân tích sẽ tạm thời lùi về chế độ thuần nguyên văn, sẽ tự động có hiệu lực sau khi phát hiện dữ liệu.
                </div>`;
            }
        }
        let extraHtml = '';
        if (p.id === 'yuzuki' && isOn) {
            extraHtml = `<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#666;margin-top:8px;cursor:pointer;">
                <input type="checkbox" id="ra_yuzuki_plot" ${data.yuzukiIncludePlot !== false ? 'checked' : ''}>
                Tiêm luôn dòng thời gian tóm tắt cốt truyện (Sau khi tắt, tư liệu tóm tắt chỉ sử dụng bảng tóm tắt ký ức)
            </label>`;
        }
        return `
        <div class="summary-provider-card ${isOn ? 'on' : ''}">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <div style="flex:1;min-width:200px;">
                    <div style="font-weight:700;font-size:14px;">${isOn ? '🟢' : '⚪'} ${h(p.name)}</div>
                    <div style="font-size:12px;color:#666;margin-top:4px;">${h(p.description)}</div>
                    ${statusHtml}
                    ${extraHtml}
                </div>
                <button class="btn ${isOn ? 'red' : 'green'}" id="ra_summary_toggle_${h(p.id)}">${isOn ? '✕ Ngừng sử dụng' : '✓ Bật giao diện'}</button>
            </div>
        </div>`;
    }).join('');

    const yuzukiPlotToggle = $('ra_yuzuki_plot');
    if (yuzukiPlotToggle) {
        on(yuzukiPlotToggle, 'change', (e) => {
            withConfigData((d) => { d.yuzukiIncludePlot = e.target.checked; });
            window.toastr?.success?.(e.target.checked ? 'Dòng thời gian tóm tắt cốt truyện đã được gộp vào tư liệu tóm tắt' : 'Tư liệu tóm tắt chỉ sử dụng bảng tóm tắt ký ức');
        });
    }

    for (const p of SUMMARY_PROVIDERS) {
        on($(`ra_summary_toggle_${p.id}`), 'click', () => {
            const cur = config.resolveConfig().data.summaryProvider || '';
            const next = cur === p.id ? '' : p.id;
            withConfigData((d) => { d.summaryProvider = next; });
            reinitEngineIfNeeded();
            refreshAll();
            window.toastr?.success?.(next ? `Đã bật giao diện tóm tắt: ${p.name} (Tính toán chu kỳ và dấu trang không bị ảnh hưởng)` : 'Đã tắt giao diện tóm tắt, khôi phục chế độ thuần nguyên văn');
        });
    }
}

async function scanRefEntries() {
    const charBook = await worldbook.getCharBookName();
    if (!charBook) throw new Error('Không tìm thấy worldbook nhân vật');
    return worldbook.scanBookKeys(charBook);
}

async function ensureScannedKeys() {
    if (!Array.isArray(ui.scannedKeys) || ui.scannedKeys.length === 0) {
        ui.scannedKeys = await scanRefEntries();
    }
    return ui.scannedKeys;
}

function promptSelectableKeys(allKeys) {
    const refNormSet = new Set((ui.refs || []).map((ref) => normalizeKeyword(ref?.entryKey || '')).filter(Boolean));
    return (Array.isArray(allKeys) ? allKeys : []).filter((key) => !refNormSet.has(normalizeKeyword(key)));
}

function renderRefPool() {
    const container = $('ra_ref_pool_list');
    if (!container) return;

    if (!ui.scanMode) {
        if (!ui.refs.length) {
            const builtinHint = activeBuiltinRefs().length > 0
                ? `<div style="font-size:12px;color:#1E4B8E;background:#eef3fa;border:1px solid #c5d5ec;border-radius:4px;padding:6px 10px;margin-bottom:8px;">📌 Tham khảo tích hợp: ${h(activeBuiltinRefs().map((b) => b.label).join('、'))} (Không cần quét, có sẵn trong mục chọn tham khảo của mọi nhiệm vụ, tự động chọn khi tạo nhiệm vụ mới; nếu worldbook có mục cùng tên thì sẽ tự động đổi sang dùng mục của bạn)</div>`
                : '';
            container.innerHTML = `${builtinHint}<div style="color:#1a1a1a;font-size:14px;padding:12px;background:#f8f8f5;border:1px dashed #999;">Tạm thời chưa có mục tham khảo, nhấp vào "Quét Worldbook Nhân vật" bên dưới để thêm</div>`;
            return;
        }
        container.innerHTML = `
        ${activeBuiltinRefs().length > 0 ? `<div style="font-size:12px;color:#1E4B8E;background:#eef3fa;border:1px solid #c5d5ec;border-radius:4px;padding:6px 10px;margin-bottom:8px;">📌 Tham khảo tích hợp: ${h(activeBuiltinRefs().map((b) => b.label).join('、'))} (Không cần quét, có sẵn trong mục chọn tham khảo của mọi nhiệm vụ, tự động chọn khi tạo nhiệm vụ mới; nếu worldbook có mục cùng tên thì sẽ tự động đổi sang dùng mục của bạn)</div>` : ''}
        <div class="ref-group ${ui.refAddedCollapsed ? 'collapsed' : ''}">
            <div class="ref-group-header" data-ref-group="added">
                <span class="fold-arrow">▼</span>
                <span>✅ Đã thêm vào tham khảo</span>
                <span class="ref-group-count">${ui.refs.length}</span>
                <span class="help-tip" data-tip="Các mục đã được chọn vào kho tham khảo.&#10;Nhấp vào dòng này để mở rộng xem/thu gọn.&#10;Muốn thêm bớt thì nhấp vào Quét, đánh dấu trong danh sách quét">?</span>
            </div>
            <div class="ref-group-body">
                ${ui.refs.map((ref) => `<div class="ref-item"><span style="color:#1a1a1a;font-size:14px;font-weight:600;">${h(ref.entryKey || '')}</span></div>`).join('')}
            </div>
        </div>`;
        return;
    }

    if (!Array.isArray(ui.scannedKeys) || ui.scannedKeys.length === 0) {
        container.innerHTML = '<div style="color:#1a1a1a;font-size:14px;padding:12px;background:#f8f8f5;border:1px dashed #999;">Tạm thời không có kết quả quét, vui lòng nhấp vào "Quét Worldbook Nhân vật"</div>';
        return;
    }

    const addedList = ui.refs.map((ref) => ({
        key: String(ref.entryKey || ''),
        inScan: ui.scannedKeys.includes(ref.entryKey),
    }));
    const addedKeySet = new Set(addedList.map((x) => x.key));
    const newKeys = ui.scannedKeys.filter((k) => !addedKeySet.has(k));

    const renderItem = (entryKey, checked, extra = '') => `
        <label class="ref-item" style="cursor:pointer;">
            <input type="checkbox" class="ref-scan-cb" data-key="${h(entryKey)}" ${checked ? 'checked' : ''}>
            <span style="color:#1a1a1a;font-size:14px;font-weight:600;">${h(entryKey)}</span>
            ${extra}
        </label>`;

    container.innerHTML = `
        <div class="ref-group ${ui.refAddedCollapsed ? 'collapsed' : ''}">
            <div class="ref-group-header" data-ref-group="added">
                <span class="fold-arrow">▼</span>
                <span>✅ Đã thêm vào tham khảo</span>
                <span class="ref-group-count">${addedList.length}</span>
            </div>
            <div class="ref-group-body">
                ${addedList.length > 0
                    ? addedList.map((x) => renderItem(x.key, true, x.inScan ? '' : '<span style="font-size:11px;color:#8B4513;background:#fff3cd;border:1px solid #ffc107;border-radius:3px;padding:0 5px;margin-left:6px;">⚠ Quét không thấy</span>')).join('')
                    : '<div class="ref-group-empty">Tạm thời chưa có mục nào được thêm</div>'}
            </div>
        </div>
        <div class="ref-group">
            <div class="ref-group-header" data-ref-group="new">
                <span class="fold-arrow">▼</span>
                <span>🆕 Chưa thêm (Kết quả quét)</span>
                <span class="ref-group-count new">${newKeys.length}</span>
            </div>
            <div class="ref-group-body">
                ${newKeys.length > 0
                    ? newKeys.map((k) => renderItem(k, false)).join('')
                    : '<div class="ref-group-empty">Tất cả các mục quét được đều đã được thêm vào kho tham khảo</div>'}
            </div>
        </div>`;
}

function wireRefPoolControls() {
    on($('ra_scan_refs_btn'), 'click', async () => {
        try {
            window.toastr?.info?.('🔍 Đang quét các mục worldbook nhân vật...');
            ui.scannedKeys = await scanRefEntries();
            ui.scanMode = true;
            renderRefPool();
            window.toastr?.success?.(`✅ Quét hoàn tất, tổng cộng ${ui.scannedKeys.length} từ khóa`);
        } catch (e) {
            window.toastr?.error?.(`Quét thất bại: ${e.message}`);
        }
    });

    on($('ra_refs_save'), 'click', async () => {
        try {
            if (ui.scanMode) {
                const checkedKeys = [...document.querySelectorAll('.ref-scan-cb:checked')]
                    .map((cb) => String(cb.dataset.key || '').trim())
                    .filter(Boolean);

                const usedVarNames = new Set();
                const oldByKey = new Map((ui.refs || []).map((ref) => [String(ref.entryKey || ''), ref]));

                const nextRefs = checkedKeys.map((entryKey) => {
                    const old = oldByKey.get(entryKey);
                    const varName = (old?.varName && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(old.varName))
                        ? (usedVarNames.add(old.varName), old.varName)
                        : buildAutoVarName(entryKey, usedVarNames);
                    return {
                        entryKey,
                        varName,
                        label: (old?.label && String(old.label).trim()) ? String(old.label).trim() : entryKey,
                    };
                });

                ui.tasks = collectTasksFromUI();
                ui.refs = nextRefs;
                ui.scanMode = false;
                renderRefPool();
                renderTaskSlots();
            }
            await saveCurrentSchemeFromUI();
            config.flushCardPersistNow().catch(() => { /* flush nội bộ đã báo cáo lỗi */ });
            window.toastr?.success?.(`✅ Đã lưu ${ui.refs.length} mục tham khảo (Chỉ giữ lại các mục được chọn)`);
        } catch (e) {
            window.toastr?.error?.('Lưu thất bại: ' + e.message);
        }
    });
}

function collectTasksFromUI() {
    const tasks = [];
    document.querySelectorAll('.task-card[data-id]').forEach((card) => {
        const id = parseInt(card.dataset.id, 10);
        if (isNaN(id)) return;

        const useRefs = [...card.querySelectorAll(`.ref-cb[data-id="${id}"]:checked`)].map((cb) => cb.dataset.var);
        const useOutputs = [...card.querySelectorAll(`.output-cb[data-id="${id}"]:checked`)].map((cb) => cb.dataset.var);

        const insertPosition = parseInt(card.querySelector(`.task-position[data-id="${id}"]`)?.value, 10) || 0;
        const depth = parseInt(card.querySelector(`.task-depth[data-id="${id}"]`)?.value, 10) || 4;
        const order = parseInt(card.querySelector(`.task-order[data-id="${id}"]`)?.value, 10) || 100;

        const cyclePosRaw = (card.querySelector(`.task-floor[data-id="${id}"]`)?.value || '')
            .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
        const firstPos = cyclePosRaw.length > 0 ? cyclePosRaw[0] : 0;

        tasks.push(config.normalizeTask({
            id,
            enabled: !!card.querySelector(`.task-enabled[data-id="${id}"]`)?.checked,
            displayName: card.querySelector(`.task-name[data-id="${id}"]`)?.value || '',
            cyclePositions: cyclePosRaw,
            cyclePosition: firstPos,
            triggerFloor: firstPos,
            promptKey: card.querySelector(`.task-prompt-select[data-id="${id}"]`)?.value || '',
            outputKey: card.querySelector(`.task-output[data-id="${id}"]`)?.value || '',
            extraKeys: card.querySelector(`.task-extrakeys[data-id="${id}"]`)?.value || '',
            outputVarName: `task_${id}_Output`,
            outputConstant: !!card.querySelector(`.task-const[data-id="${id}"]`)?.checked,
            outputDisable: card.querySelector(`.task-hide[data-id="${id}"]`)?.checked ? 1 : 0,
            selective: !!card.querySelector(`.task-sel[data-id="${id}"]`)?.checked,
            selectiveKeysEnabled: !!card.querySelector(`.task-selkeys-enabled[data-id="${id}"]`)?.checked,
            selectiveKeys: (card.querySelector(`.task-selkeys-enabled[data-id="${id}"]`)?.checked
                ? (card.querySelector(`.task-selkeys-input[data-id="${id}"]`)?.value || '').split(',').map((s) => s.trim()).filter(Boolean)
                : []),
            keywordScanEnabled: !!card.querySelector(`.task-keyword-scan-enabled[data-id="${id}"]`)?.checked,
            keywordScanKeywords: [...card.querySelectorAll(`.task-keyword-scan-input[data-id="${id}"]`)].map((input) => input.value.trim()).filter(Boolean),
            noRecursion: !!card.querySelector(`.task-no-recursion[data-id="${id}"]`)?.checked,
            position: insertPosition,
            depth,
            order,
            useReferences: useRefs,
            useOutputs: useOutputs,
        }));
    });

    // Các trường của chế độ đạo diễn (Mức độ ưu tiên/Giới thiệu được chỉnh sửa ở trang đạo diễn, thẻ nhiệm vụ không render) được gộp và trả về từ ui.tasks, tránh bị mất khi tạo lại đối tượng nhiệm vụ
    for (const t of tasks) {
        const prev = (ui.tasks || []).find((pt) => pt.id === t.id);
        if (prev) {
            t.directorPriority = Number.isFinite(Number(prev.directorPriority)) ? Math.round(Number(prev.directorPriority)) : 0;
            t.directorSummary = String(prev.directorSummary || '');
        }
    }

    const refKeyByVar = new Map((ui.refs || []).map((r) => [String(r.varName || ''), String(r.entryKey || '').trim()]));
    const outputKeyByVar = new Map(tasks.map((t) => [String(t.outputVarName || `task_${t.id}_Output`), String(t.outputKey || '').trim()]));

    for (const t of tasks) {
        const selectedRefKeys = (Array.isArray(t.useReferences) ? t.useReferences : [])
            .map((varName) => refKeyByVar.get(String(varName || '')) || '')
            .filter(Boolean);
        const selfOutputVar = String(t.outputVarName || `task_${t.id}_Output`);
        t.useOutputs = (Array.isArray(t.useOutputs) ? t.useOutputs : []).filter((varName) => {
            if (String(varName || '') === selfOutputVar) return true;
            const outKey = outputKeyByVar.get(String(varName || ''));
            if (!outKey) return true;
            return !selectedRefKeys.some((refKey) => isKeywordSimilar(refKey, outKey));
        });
    }
    return tasks;
}

function renderKeywordScanRows(task) {
    const keywords = Array.isArray(task.keywordScanKeywords) ? task.keywordScanKeywords.map(String) : [];
    if (keywords.length === 0) {
        return '<div style="font-size:12px;color:#666;padding:6px 0;">Chưa điền từ khóa: Sẽ gửi phân tích mặc định khi đến chu kỳ</div>';
    }
    return keywords.map((keyword, idx) => `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
            <input class="task-keyword-scan-input w250" data-id="${task.id}" value="${h(keyword)}" placeholder="Nhập từ khóa chính văn">
            <button type="button" class="btn outline small task-keyword-remove" data-id="${task.id}" data-index="${idx}">Xóa</button>
        </div>
    `).join('');
}

function renderTaskSlots() {
    const container = $('ra_task_slots');
    if (!container) return;

    if (ui.tasks.length === 0) {
        container.innerHTML = '<div class="empty-tasks">Tạm thời chưa có nhiệm vụ, nhấp vào nút "Thêm nhiệm vụ mới" bên dưới để tạo</div>';
        return;
    }

    const promptOptions = promptSelectableKeys(ui.scannedKeys || []);
    const promptOptionSet = new Set(promptOptions.map((k) => String(k)));
    const refNormSet = new Set((ui.refs || []).map((ref) => normalizeKeyword(ref?.entryKey || '')).filter(Boolean));

    container.innerHTML = ui.tasks.map((task) => {
        const positions = activePositionsOf(task);
        const positionsStr = positions.join(',') || '';
        const currentPrompt = String(task.promptKey || '').trim();
        const currentAllowed = !!currentPrompt && !refNormSet.has(normalizeKeyword(currentPrompt));
        let promptOptionsHtml = '<option value="">Vui lòng chọn từ khóa (Quét trước)</option>';
        if (currentAllowed && !promptOptionSet.has(currentPrompt)) {
            promptOptionsHtml += `<option value="${h(currentPrompt)}" selected>${h(currentPrompt)} (Hiện tại)</option>`;
        }
        promptOptionsHtml += promptOptions.map((k) => `<option value="${h(k)}" ${currentPrompt === k ? 'selected' : ''}>${h(k)}</option>`).join('');

        return `
        <div class="task-card ${task.enabled ? '' : 'disabled'} ${ui.expandedTasks.has(task.id) ? '' : 'collapsed'}" data-id="${task.id}">
            <div class="task-card-header">
                <button type="button" class="task-toggle-btn" data-id="${task.id}" title="Mở rộng/Thu gọn cấu hình chi tiết của nhiệm vụ này">${ui.expandedTasks.has(task.id) ? '▾' : '▸'} Cấu hình</button>
                <label class="inline"><input type="checkbox" class="task-enabled" data-id="${task.id}" ${task.enabled ? 'checked' : ''}> Bật</label>
                <span class="task-card-title">#${task.id}</span>
                <input class="task-name w120" data-id="${task.id}" value="${h(task.displayName || '')}" placeholder="Tên nhiệm vụ">
                <label class="inline" title="Kích hoạt vào lần phản hồi AI thứ mấy trong chu kỳ (Hỗ trợ nhiều giá trị, phân cách bằng dấu phẩy, ví dụ: 5,10,15)">Vị trí chu kỳ<input class="task-floor w120" data-id="${task.id}" value="${h(positionsStr)}" placeholder="5,10,15"></label>
                <button type="button" class="task-delete-btn" data-id="${task.id}">✕ Xóa</button>
            </div>
            <div class="task-card-body">
                <div class="form-row">
                    <span class="form-label">Mục Prompt</span>
                    <span class="form-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <select class="task-prompt-select w250" data-id="${task.id}">${promptOptionsHtml}</select>
                        <button type="button" class="btn outline small task-scan-prompt" data-id="${task.id}">🔍 Quét từ khóa</button>
                    </span>
                </div>
                <div class="form-row">
                    <span class="form-label">Mục Đầu ra</span>
                    <input class="task-output w250" data-id="${task.id}" value="${h(task.outputKey || '')}" placeholder="Từ khóa Worldbook">
                </div>
                <div class="tip" style="margin-top:0;padding:6px 8px;font-size:11px;">
                    Đây là tên mục trong worldbook chat nơi kết quả phân tích được ghi vào, không được trùng với "Mục Prompt".
                </div>
                <div class="form-row" style="background:#e8f4e8;padding:8px 10px;border-radius:3px;">
                    <span class="form-label">📤 Biến đầu ra</span>
                    <code style="font-size:14px;font-weight:700;color:#1E4B8E;">{{task_${task.id}_Output}}</code>
                    <span style="font-size:12px;color:#666;margin-left:8px;">← Các nhiệm vụ khác có thể dùng biến này để tham chiếu đầu ra của nhiệm vụ này</span>
                </div>
                <div class="form-row">
                    <span class="form-label">Từ khóa phụ</span>
                    <input class="task-extrakeys w250" data-id="${task.id}" value="${h(task.extraKeys || '')}" placeholder="Tên nhân vật v.v., phân cách bằng dấu phẩy">
                </div>
                <div class="form-row">
                    <span class="form-label">Quét chính văn</span>
                    <span class="form-value" style="display:flex;flex-direction:column;gap:8px;align-items:flex-start;">
                        <label class="inline"><input type="checkbox" class="task-keyword-scan-enabled" data-id="${task.id}" ${task.keywordScanEnabled ? 'checked' : ''}> Sử dụng cơ chế quét từ khóa</label>
                        <div class="task-keyword-scan-wrap ${task.keywordScanEnabled ? '' : 'hidden'}" data-id="${task.id}" style="width:100%;">
                            <div class="task-keyword-scan-list" data-id="${task.id}">${renderKeywordScanRows(task)}</div>
                            <button type="button" class="btn outline small task-keyword-add" data-id="${task.id}">Thêm từ khóa</button>
                            <div class="tip" style="margin-top:6px;padding:6px 8px;font-size:11px;">
                                Sau khi đánh dấu sẽ quét chính văn trước khi gửi API; nếu không điền từ khóa, khi đến chu kỳ sẽ phân tích như bình thường; nếu điền nhiều từ khóa, chỉ gửi khi trúng bất kỳ từ khóa nào.
                            </div>
                        </div>
                    </span>
                </div>
                <div class="form-row">
                    <span class="form-label">Thuộc tính đầu ra</span>
                    <span class="form-value" style="display:flex;gap:12px;flex-wrap:wrap;">
                        <label class="inline"><input type="checkbox" class="task-const output-mode-radio" data-id="${task.id}" data-group="task_${task.id}" ${task.outputConstant ? 'checked' : ''}> 🔵 Đèn xanh dương</label>
                        <label class="inline"><input type="checkbox" class="task-sel output-mode-radio" data-id="${task.id}" data-group="task_${task.id}" ${task.selective ? 'checked' : ''}> 🟢 Đèn xanh lá</label>
                        <label class="inline"><input type="checkbox" class="task-hide output-mode-radio" data-id="${task.id}" data-group="task_${task.id}" ${task.outputDisable ? 'checked' : ''}> ⚫ Vô hiệu hóa mục</label>
                        <span style="border-left:1px solid #999;padding-left:12px;margin-left:4px;">
                            <label class="inline"><input type="checkbox" class="task-no-recursion" data-id="${task.id}" ${task.noRecursion ? 'checked' : ''}> 🚫 Không đệ quy</label>
                        </span>
                    </span>
                </div>
                <div class="tip" style="margin-top:4px;margin-bottom:8px;padding:6px 8px;font-size:11px;">
                    🔵Đèn xanh dương = Luôn kích hoạt | 🟢Đèn xanh lá = Từ khóa kích hoạt | ⚫Vô hiệu hóa mục = Không tiêm vào cốt truyện | 🚫Không đệ quy = Cấm kích hoạt đệ quy
                </div>
                <div class="form-row">
                    <span class="form-label">Từ khóa lọc</span>
                    <span class="form-value" style="display:flex;flex-direction:column;gap:6px;align-items:flex-start;">
                        <label class="inline"><input type="checkbox" class="task-selkeys-enabled" data-id="${task.id}" ${task.selectiveKeysEnabled ? 'checked' : ''}> Sử dụng từ khóa lọc tùy chọn</label>
                        <input class="task-selkeys-input w250" data-id="${task.id}" value="${h((Array.isArray(task.selectiveKeys) ? task.selectiveKeys : []).join(', '))}" placeholder="Phân cách bằng dấu phẩy, ví dụ: nsfw" ${task.selectiveKeysEnabled ? '' : 'hidden'}>
                        <span class="tip" style="padding:4px 8px;font-size:11px;">Chỉ có tác dụng với mục đầu ra 🟢Đèn xanh lá: Sau khi đánh dấu và điền nội dung, mục cần trúng đồng thời "Từ khóa chính + Từ khóa lọc" mới kích hoạt; khi không đánh dấu, mục đầu ra tuyệt đối không mang theo bất kỳ từ khóa lọc nào (các tàn dư lịch sử sẽ tự động được dọn dẹp).</span>
                    </span>
                </div>
                <div class="form-row">
                    <span class="form-label">📍 Vị trí chèn</span>
                    <span class="form-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <select class="task-position w150" data-id="${task.id}">
                            <option value="0" ${(task.position ?? 0) === 0 ? 'selected' : ''}>Trước thiết lập nhân vật</option>
                            <option value="1" ${task.position === 1 ? 'selected' : ''}>Sau thiết lập nhân vật</option>
                            <option value="4" ${task.position === 4 ? 'selected' : ''}>Định vị độ sâu @D</option>
                        </select>
                        <span class="task-depth-wrap ${task.position === 4 ? '' : 'hidden'}" data-id="${task.id}">
                            <label class="inline">Độ sâu<input class="task-depth w100" data-id="${task.id}" type="number" min="0" max="999" value="${task.depth ?? 4}" placeholder="4"></label>
                        </span>
                        <label class="inline">Thứ tự<input class="task-order w100" data-id="${task.id}" type="number" min="0" max="9999" value="${task.order ?? 100}" placeholder="100"></label>
                    </span>
                </div>
                <div class="form-row">
                    <span class="form-label">Tham chiếu Kho tham khảo</span>
                    <div class="checkbox-group task-refs" data-id="${task.id}"></div>
                </div>
                <div class="form-row">
                    <span class="form-label">Tham chiếu Đầu ra nhiệm vụ</span>
                    <div class="checkbox-group task-outputs" data-id="${task.id}"></div>
                </div>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.task-enabled').forEach((cb) => {
        on(cb, 'change', () => {
            const id = parseInt(cb.dataset.id, 10);
            const card = container.querySelector(`.task-card[data-id="${id}"]`);
            if (card) card.classList.toggle('disabled', !cb.checked);
            renderCycleInfo();
        });
    });

    container.querySelectorAll('.task-delete-btn').forEach((btn) => {
        on(btn, 'click', () => {
            const id = parseInt(btn.dataset.id, 10);
            const idx = ui.tasks.findIndex((t) => t.id === id);
            if (idx >= 0) {
                const name = ui.tasks[idx].displayName || `Nhiệm vụ#${id}`;
                if (window.confirm(`Bạn có chắc muốn xóa "${name}" không?`)) {
                    ui.tasks = collectTasksFromUI();
                    const delIdx = ui.tasks.findIndex((t) => t.id === id);
                    if (delIdx >= 0) ui.tasks.splice(delIdx, 1);
                    renderTaskSlots();
                    renderCycleInfo();
                    window.toastr?.info?.(`Đã xóa ${name}`);
                }
            }
        });
    });

    container.querySelectorAll('.task-scan-prompt').forEach((btn) => {
        on(btn, 'click', async () => {
            const id = parseInt(btn.dataset.id, 10);
            if (isNaN(id)) return;
            const sel = container.querySelector(`.task-prompt-select[data-id="${id}"]`);
            if (!sel) return;
            try {
                const oldText = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'Đang quét...';
                const keys = await ensureScannedKeys();
                const availableKeys = promptSelectableKeys(keys);
                const task = ui.tasks.find((t) => t.id === id);
                const current = String(task?.promptKey || sel.value || '').trim();
                sel.innerHTML = '<option value="">Vui lòng chọn từ khóa...</option>' + availableKeys.map((k) => `<option value="${h(k)}">${h(k)}</option>`).join('');
                sel.value = (current && availableKeys.includes(current)) ? current : '';
                sel.disabled = availableKeys.length === 0;
                btn.textContent = oldText;
            } catch (e) {
                window.toastr?.error?.(`Quét thất bại: ${e.message}`);
                btn.textContent = '🔍 Quét từ khóa';
            } finally {
                btn.disabled = false;
            }
        });
    });

    container.querySelectorAll('.task-floor').forEach((input) => {
        on(input, 'input', renderCycleInfo);
    });
    container.querySelectorAll('.task-name').forEach((input) => {
        on(input, 'input', renderCycleInfo);
    });
    container.querySelectorAll('.task-position').forEach((sel) => {
        on(sel, 'change', () => {
            const depthWrap = container.querySelector(`.task-depth-wrap[data-id="${sel.dataset.id}"]`);
            if (depthWrap) depthWrap.classList.toggle('hidden', sel.value !== '4');
        });
    });
    container.querySelectorAll('.output-mode-radio').forEach((cb) => {
        on(cb, 'change', () => {
            if (!cb.checked) return;
            const group = cb.dataset.group;
            if (!group) return;
            container.querySelectorAll(`.output-mode-radio[data-group="${group}"]`).forEach((other) => {
                if (other !== cb) other.checked = false;
            });
        });
    });
    container.querySelectorAll('.task-selkeys-enabled').forEach((cb) => {
        on(cb, 'change', () => {
            const input = container.querySelector(`.task-selkeys-input[data-id="${cb.dataset.id}"]`);
            if (input) input.hidden = !cb.checked;
        });
    });
    container.querySelectorAll('.task-keyword-scan-enabled').forEach((cb) => {
        on(cb, 'change', () => {
            const id = parseInt(cb.dataset.id, 10);
            const task = ui.tasks.find((t) => t.id === id);
            if (task) task.keywordScanEnabled = cb.checked;
            const wrap = container.querySelector(`.task-keyword-scan-wrap[data-id="${id}"]`);
            if (wrap) wrap.classList.toggle('hidden', !cb.checked);
        });
    });
    container.querySelectorAll('.task-keyword-add').forEach((btn) => {
        on(btn, 'click', () => {
            const id = parseInt(btn.dataset.id, 10);
            ui.tasks = collectTasksFromUI();
            const task = ui.tasks.find((t) => t.id === id);
            if (!task) return;
            task.keywordScanEnabled = true;
            task.keywordScanKeywords = [...(task.keywordScanKeywords || []).map(String), ''];
            renderTaskSlots();
        });
    });
    container.querySelectorAll('.task-keyword-remove').forEach((btn) => {
        on(btn, 'click', () => {
            const id = parseInt(btn.dataset.id, 10);
            const index = parseInt(btn.dataset.index, 10);
            ui.tasks = collectTasksFromUI();
            const task = ui.tasks.find((t) => t.id === id);
            if (!task || isNaN(index)) return;
            task.keywordScanKeywords = (task.keywordScanKeywords || []).filter((_, i) => i !== index);
            renderTaskSlots();
        });
    });
    container.querySelectorAll('.task-keyword-scan-input').forEach((input) => {
        on(input, 'input', () => {
            const id = parseInt(input.dataset.id, 10);
            const task = ui.tasks.find((t) => t.id === id);
            if (!task) return;
            task.keywordScanKeywords = [...container.querySelectorAll(`.task-keyword-scan-input[data-id="${id}"]`)].map((el) => el.value);
        });
    });

    updateRefCheckboxes();
}

/**
 * Các mục tham khảo tích hợp có thể chọn hiện tại: Khi trong kho tham khảo tồn tại mục cùng từ khóa thì mục tích hợp đó sẽ bị che khuất (ẩn đi),
 * lúc này việc đánh dấu "Thư viện ràng buộc" là đang đánh dấu mục do người sáng tạo tự thêm vào kho; phía engine luôn ưu tiên worldbook,
 * bất kể trạng thái bảng điều khiển ra sao đều sẽ phân tích chính xác (worldbook có mục cùng tên thì dùng mục của người dùng, không đọc được mới dùng nội dung tích hợp).
 * Lưu ý: Chỉ xét các mục đã thêm vào kho tham khảo——mục quét được nhưng chưa thêm vào kho có cùng từ khóa sẽ không che khuất
 * (vì đó không phải là "mục tham khảo đã được tạo", nếu ẩn sẽ làm mất hộp kiểm có thể chọn theo mặc định).
 */
function activeBuiltinRefs() {
    const candidates = (ui.refs || []).map((r) => r.entryKey);
    return BUILTIN_REFERENCES.filter((b) => !findShadowingKey(b, candidates));
}

function updateRefCheckboxes() {
    const activeBuiltins = activeBuiltinRefs();
    document.querySelectorAll('.task-refs').forEach((el) => {
        const id = parseInt(el.dataset.id, 10);
        const task = ui.tasks.find((t) => t.id === id);
        const used = task?.useReferences || [];
        const items = [
            ...ui.refs.map((ref) => {
                const checked = used.includes(ref.varName) ? 'checked' : '';
                return `<label><input type="checkbox" class="ref-cb" data-id="${id}" data-var="${h(ref.varName)}" ${checked}> ${h(ref.label || ref.varName)}</label>`;
            }),
            ...activeBuiltins.map((b) => {
                const checked = used.includes(b.varName) ? 'checked' : '';
                return `<label title="Nội dung thư viện ràng buộc tích hợp của plugin (Tiêu chuẩn kiểm tra chống văn mẫu). Nếu worldbook tồn tại mục cùng tên thì mục này tự động ẩn, khi phân tích sẽ đổi sang dùng mục của bạn."><input type="checkbox" class="ref-cb" data-id="${id}" data-var="${h(b.varName)}" ${checked}> ${h(b.label)} (Tích hợp)</label>`;
            }),
        ];
        el.innerHTML = items.join('') || '<span style="color:#555;font-size:13px;">Không có</span>';
    });

    const outputVars = ui.tasks.map((t) => ({ varName: t.outputVarName || `task_${t.id}_Output`, label: t.displayName || `Nhiệm vụ#${t.id}`, id: t.id }));
    document.querySelectorAll('.task-outputs').forEach((el) => {
        const currentId = parseInt(el.dataset.id, 10);
        const task = ui.tasks.find((t) => t.id === currentId);
        const used = task?.useOutputs || [];
        el.innerHTML = outputVars.map((o) => {
            const isSelf = o.id === currentId;
            const checked = used.includes(o.varName) ? 'checked' : '';
            const label = isSelf ? `${h(o.label)} (Kết quả lần trước)` : h(o.label);
            const style = isSelf ? 'background:#e8f5e9;border-color:#4caf50;' : '';
            return `<label style="${style}"><input type="checkbox" class="output-cb" data-id="${currentId}" data-var="${h(o.varName)}" ${checked}> ${label}</label>`;
        }).join('') || '<span style="color:#555;font-size:13px;">Không có</span>';
    });
}

function renderCycleInfo() {
    const lengthBadge = $('ra_cycle_length_badge');
    const counterBadge = $('ra_cycle_counter_badge');
    const timeline = $('ra_cycle_timeline');
    const taskList = $('ra_cycle_task_list');
    if (!lengthBadge || !timeline || !taskList) return;

    const c = ctx();
    const currentCounter = c ? countAiReplies(c.chat) : 0;

    // Chế độ đạo diễn: Dòng thời gian theo dõi động kế hoạch của đạo diễn (tầng tuyệt đối), không còn đọc vị trí chu kỳ tĩnh
    const ds = engine.getEngineState()?.director;
    if (ds?.enabled) {
        renderDirectorCycle(ds, { lengthBadge, counterBadge, timeline, taskList, currentCounter });
        return;
    }

    const tasksFromUI = [];
    document.querySelectorAll('.task-card[data-id]').forEach((card) => {
        const taskId = parseInt(card.dataset.id, 10);
        if (isNaN(taskId)) return;
        const enabled = !!card.querySelector(`.task-enabled[data-id="${taskId}"]`)?.checked;
        const name = card.querySelector(`.task-name[data-id="${taskId}"]`)?.value || `Nhiệm vụ#${taskId}`;
        const positionsRaw = (card.querySelector(`.task-floor[data-id="${taskId}"]`)?.value || '')
            .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
        if (enabled && positionsRaw.length > 0) {
            tasksFromUI.push({ id: taskId, name, positions: positionsRaw });
        }
    });

    if (tasksFromUI.length === 0) {
        lengthBadge.textContent = 'Độ dài chu kỳ: Chưa cấu hình nhiệm vụ';
        counterBadge.textContent = `Phản hồi AI: ${currentCounter}`;
        timeline.innerHTML = `
            <div class="cycle-track"><div class="cycle-axis"></div></div>
            <div style="text-align:center;padding:16px;color:#666;position:relative;z-index:1;">Vui lòng thêm nhiệm vụ phân tích</div>`;
        taskList.innerHTML = '';
        return;
    }

    let maxPosition = 0;
    for (const task of tasksFromUI) {
        const taskMax = Math.max(...task.positions);
        if (taskMax > maxPosition) maxPosition = taskMax;
    }
    const currentPosition = maxPosition > 0 ? ((currentCounter % maxPosition) || maxPosition) : 0;

    lengthBadge.textContent = `Độ dài chu kỳ: ${maxPosition} lần phản hồi AI`;
    counterBadge.textContent = `Phản hồi AI: ${currentCounter} (Vị trí ${currentPosition})`;
    counterBadge.title = 'Số tầng phản hồi AI hiện tại (Tính trực tiếp từ lịch sử trò chuyện, không cần reset)';

    const allEvents = tasksFromUI
        .map((task) => ({
            position: Math.min(...task.positions),
            positionsDisplay: task.positions.join(','),
            name: task.name,
            allPositions: task.positions,
        }))
        .sort((a, b) => a.position - b.position);

    let prevLeftPercent = -100;
    allEvents.forEach((event) => {
        const leftPercent = 10 + (event.position / maxPosition) * 80;
        const gap = leftPercent - prevLeftPercent;
        if (gap >= 20) event._level = 'l1';
        else if (gap >= 11) event._level = 'l2';
        else event._level = 'l3';
        prevLeftPercent = leftPercent;
    });
    for (let i = 1; i < allEvents.length; i++) {
        if (allEvents[i]._level === 'l3' && allEvents[i - 1]._level === 'l3' && i % 2 === 0) {
            allEvents[i]._level = 'l2';
        }
    }

    let trackHtml = '<div class="cycle-track"><div class="cycle-axis"></div>';
    allEvents.forEach((event) => {
        const leftPercent = 10 + (event.position / maxPosition) * 80;
        trackHtml += `
            <div class="cycle-marker ${event._level || 'l1'}" style="left:${leftPercent}%;">
                <span class="marker-line task"></span>
                <span class="marker-dot task"></span>
                <span class="marker-floor">Vị trí ${event.positionsDisplay}</span>
                <span class="marker-label">${h(event.name)}</span>
            </div>`;
    });
    trackHtml += `
        <div class="cycle-marker l1" style="left:96%;opacity:0.65;">
            <span class="marker-line" style="background:#8a8a8a;box-shadow:none;"></span>
            <span class="marker-dot end"></span>
            <span class="marker-floor">Kết thúc chu kỳ</span>
            <span class="marker-label" style="font-size:10px;color:#666;">🔁 Quay lại vị trí 1</span>
        </div>`;
    trackHtml += '</div>';
    timeline.innerHTML = trackHtml;

    let listHtml = '<div style="font-size:12px;font-weight:600;color:#666;margin-bottom:8px;">📋 Thứ tự thực thi nhiệm vụ (Theo vị trí chu kỳ):</div>';
    allEvents.forEach((event, i) => {
        const isCurrent = event.allPositions.includes(currentPosition);
        listHtml += `
            <div class="cycle-task-item" style="${isCurrent ? 'background:#e3f2fd;border-color:#2196f3;' : ''}">
                <span class="floor-badge" style="${isCurrent ? 'box-shadow:0 0 0 2px #2196f3;' : ''}">Vị trí ${event.positionsDisplay}</span>
                <span class="task-name">${i + 1}. ${h(event.name)}${isCurrent ? ' 👈 Hiện tại' : ''}</span>
                <span class="output-var">{{task_${event.id}_Output}}</span>
            </div>`;
    });
    listHtml += `
        <div class="cycle-task-item" style="background:#f0f0e8;border-style:dashed;">
            <span class="floor-badge" style="background:#666;">Sau vị trí ${maxPosition}</span>
            <span class="task-name" style="color:#666;">🔄 Bắt đầu chu kỳ mới, quay lại vị trí 1</span>
            <span class="output-var" style="color:#888;">Vòng lặp chu kỳ</span>
        </div>`;
    taskList.innerHTML = listHtml;
}

/** Xây dựng biểu đồ kế hoạch đạo diễn (Dùng chung cho dòng thời gian của người sáng tạo và lịch trình nhiệm vụ của người chơi): 🎬Điểm bắt đầu → Điểm nhiệm vụ (Đã kích hoạt✅) → ▶Hiện tại → 🎬Đạo diễn lần tới */
function buildDirectorCycleParts(ds, currentCounter) {
    const anchor = ds.anchor || 0;
    const nextFloor = ds.nextDirectorFloor || (anchor + ds.cycleLength);
    const span = Math.max(1, nextFloor - anchor);
    const nameOf = (taskId) => {
        const t = ui.tasks.find((x) => x.id === taskId);
        return t ? (t.displayName || `Nhiệm vụ#${t.id}`) : `Nhiệm vụ#${taskId}`;
    };
    const badge = ds.aggressive ? `Khoảng cách đạo diễn: Do đạo diễn tự quyết định (Lần tới tại tầng ${nextFloor})` : `Độ dài chu kỳ: ${ds.cycleLength} lần phản hồi AI`;
    const counter = `Phản hồi AI: ${currentCounter} (Độ lệch ${ds.offset})`;

    if (!ds.planReady) {
        return { waiting: true, waitNote: `Đang chờ đạo diễn lên lịch (Đạo diễn lần tới: Tầng ${nextFloor})`, badge, counter };
    }

    const events = (ds.planAssignments || [])
        .map((a) => ({ floor: a.floor, taskId: a.taskId, name: nameOf(a.taskId) }))
        .sort((a, b) => a.floor - b.floor);

    // Xếp lớp thẻ (Cùng quy tắc với dòng thời gian tĩnh)
    let prevLeft = -100;
    events.forEach((ev) => {
        const left = 10 + ((ev.floor - anchor) / span) * 80;
        const gap = left - prevLeft;
        ev._level = gap >= 20 ? 'l1' : gap >= 11 ? 'l2' : 'l3';
        prevLeft = left;
    });
    for (let i = 1; i < events.length; i++) {
        if (events[i]._level === 'l3' && events[i - 1]._level === 'l3' && i % 2 === 0) events[i]._level = 'l2';
    }

    let trackHtml = '<div class="cycle-track"><div class="cycle-axis"></div>';
    trackHtml += `
        <div class="cycle-marker l1" style="left:10%;">
            <span class="marker-line" style="background:#C41E3A;"></span>
            <span class="marker-dot director"></span>
            <span class="marker-floor">Tầng ${anchor}</span>
            <span class="marker-label" style="color:#C41E3A;font-weight:600;">🎬 Đạo diễn</span>
        </div>`;
    events.forEach((ev) => {
        const left = 10 + ((ev.floor - anchor) / span) * 80;
        const done = ev.floor <= currentCounter;
        trackHtml += `
            <div class="cycle-marker ${ev._level}" style="left:${left}%;${done ? 'opacity:0.75;' : ''}">
                <span class="marker-line task"></span>
                <span class="marker-dot task"></span>
                <span class="marker-floor">Tầng ${ev.floor}${done ? ' ✅' : ''}</span>
                <span class="marker-label">${h(ev.name)}</span>
            </div>`;
    });
    if (currentCounter > anchor && currentCounter < nextFloor) {
        const left = 10 + ((currentCounter - anchor) / span) * 80;
        trackHtml += `
        <div class="cycle-marker l1" style="left:${left}%;">
            <span class="marker-line" style="background:#2196f3;"></span>
            <span class="marker-dot" style="background:#2196f3;"></span>
            <span class="marker-floor" style="color:#2196f3;">Hiện tại</span>
            <span class="marker-label" style="font-size:10px;color:#2196f3;">▶ Tầng ${currentCounter}</span>
        </div>`;
    }
    trackHtml += `
        <div class="cycle-marker l1" style="left:96%;opacity:0.85;">
            <span class="marker-line" style="background:#C41E3A;box-shadow:none;"></span>
            <span class="marker-dot director"></span>
            <span class="marker-floor">Tầng ${nextFloor}</span>
            <span class="marker-label" style="font-size:10px;color:#C41E3A;">🎬 Đạo diễn lần tới${ds.aggressive ? ' (Đạo diễn tự quyết)' : ''}</span>
        </div>`;
    trackHtml += '</div>';

    let listHtml = `<div style="font-size:12px;font-weight:600;color:#666;margin-bottom:8px;">📋 Kế hoạch đạo diễn (Lần đạo diễn thứ ${ds.runSeq}${ds.aggressive ? '·Quyết liệt' : ''}, theo số tầng):</div>`;
    events.forEach((ev, i) => {
        const done = ev.floor <= currentCounter;
        listHtml += `
            <div class="cycle-task-item" style="${done ? 'background:#e8f5e9;' : ''}">
                <span class="floor-badge" style="${done ? 'background:#2C5530;' : ''}">Tầng ${ev.floor}</span>
                <span class="task-name">${i + 1}. ${h(ev.name)}${done ? ' ✅ Đã kích hoạt' : ''}</span>
                <span class="output-var">{{task_${ev.taskId}_Output}}</span>
            </div>`;
    });
    listHtml += `
        <div class="cycle-task-item" style="background:#fdf3f4;border-style:dashed;">
            <span class="floor-badge" style="background:#C41E3A;">Tầng ${nextFloor}</span>
            <span class="task-name" style="color:#C41E3A;">🎬 Đạo diễn lần tới${ds.aggressive ? ' (Khoảng cách do đạo diễn tự quyết)' : ` (Chu kỳ ${ds.cycleLength})`}</span>
            <span class="output-var" style="color:#888;">Lên lịch đạo diễn</span>
        </div>`;

    return { waiting: false, badge, counter, track: trackHtml, list: listHtml };
}

/** Dòng thời gian chế độ đạo diễn (Trang nhiệm vụ bảng người sáng tạo): Phân khu render Huy hiệu + Biểu đồ + Danh sách nhiệm vụ */
function renderDirectorCycle(ds, els) {
    const { lengthBadge, counterBadge, timeline, taskList, currentCounter } = els;
    const parts = buildDirectorCycleParts(ds, currentCounter);
    lengthBadge.textContent = parts.badge;
    counterBadge.textContent = parts.counter;
    counterBadge.title = 'Số tầng phản hồi AI hiện tại; trong chế độ đạo diễn hiển thị dưới dạng "Độ lệch kể từ lần đạo diễn trước"';
    if (parts.waiting) {
        timeline.innerHTML = `
            <div class="cycle-track"><div class="cycle-axis"></div></div>
            <div style="text-align:center;padding:16px;color:#666;position:relative;z-index:1;">${parts.waitNote}</div>`;
        taskList.innerHTML = '<div style="font-size:12px;color:#666;padding:8px;">Đạo diễn chưa tạo kế hoạch lần này——có thể thực thi lên lịch thủ công một lần tại trang đạo diễn</div>';
        return;
    }
    timeline.innerHTML = parts.track;
    taskList.innerHTML = parts.list;
}

async function saveCurrentSchemeFromUI() {
    const { data } = config.resolveConfig();
    const presets = data.presets;
    const idx = presets.findIndex((p) => p.id === ui.editingPresetId);
    if (idx < 0) return;

    const schemeName = $('ra_scheme_name_input')?.value.trim() || presets[idx].name || 'Chưa đặt tên';
    presets[idx] = {
        ...presets[idx],
        name: schemeName,
        referencePool: ui.refs,
        tasks: collectTasksFromUI(),
        nextTaskId: ui.nextTaskId,
        director: config.normalizePreset({ director: collectDirectorFromUI() }).director,
    };
    config.saveConfigData(data);
}

function loadSchemeToUI(presetId) {
    const { data } = config.resolveConfig();
    const preset = data.presets.find((p) => p.id === presetId);
    if (!preset) return;

    ui.editingPresetId = preset.id;
    $('ra_scheme_name_input').value = preset.name || 'Chưa đặt tên';

    const activateBtn = $('ra_scheme_activate_btn');
    if (activateBtn) {
        const isActive = preset.id === data.activePresetId;
        activateBtn.textContent = isActive ? '✅ Đã kích hoạt' : '🎯 Kích hoạt';
        activateBtn.disabled = isActive;
    }
    const deleteBtn = $('ra_scheme_delete_btn');
    if (deleteBtn) deleteBtn.disabled = data.presets.length <= 1;

    ui.refs = preset.referencePool ? [...preset.referencePool] : [];
    renderRefPool();

    ui.tasks = preset.tasks ? preset.tasks.map((t) => ({ ...t })) : [];
    ui.nextTaskId = preset.nextTaskId || (ui.tasks.length > 0 ? Math.max(...ui.tasks.map((t) => t.id || 0)) + 1 : 1);
    ui.director = preset.director ? config.normalizePreset({ director: preset.director }).director : config.normalizePreset({}).director;
    renderTaskSlots();
    renderCycleInfo();
    if (ui.directorViewActive) renderDirectorView();
}

// ---------- Khung nhìn Chế độ Đạo diễn ----------

function renderDirectorRefs(dir) {
    const refs = ui.refs || [];
    if (refs.length === 0) {
        return '<span style="color:#555;font-size:13px;">Kho mục tham khảo trống——hãy quét và thêm mục ở trang "Mục tham khảo" trước, sau đó quay lại đây đánh dấu để đạo diễn đọc.</span>';
    }
    const selected = new Set(dir.useReferences || []);
    return refs.map((ref) => `
        <label><input type="checkbox" class="director-ref-cb" data-var="${h(ref.varName)}" ${selected.has(ref.varName) ? 'checked' : ''}> ${h(ref.label || ref.entryKey)}</label>
    `).join('');
}

function renderDirectorTasks(tasks) {
    return tasks.map((t) => `
        <div class="director-task-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
            <span style="min-width:110px;font-weight:600;font-size:13px;">#${t.id} ${h(t.displayName || '')}</span>
            <label style="font-size:12px;color:#666;display:flex;align-items:center;gap:4px;">Mức ưu tiên
                <input type="number" class="director-priority w80" data-id="${t.id}" value="${Number(t.directorPriority) || 0}" min="0" max="99">
            </label>
            <input type="text" class="director-summary w250" data-id="${t.id}" value="${h(t.directorSummary || '')}" placeholder="Tóm tắt nhiệm vụ (Để trống sẽ tự động trích xuất từ mục prompt)">
            <button type="button" class="btn outline small director-brief-preview" data-id="${t.id}" title="Xem trước tóm tắt nhiệm vụ mà đạo diễn sẽ nhận được">👁 Xem trước tóm tắt</button>
        </div>
    `).join('');
}

function updateDirectorStatus() {
    const el = $('ra_director_status');
    if (!el) return;
    const ds = engine.getEngineState()?.director;
    if (!ds?.enabled) {
        el.innerHTML = '⚪ Chu kỳ đạo diễn chưa được bật. Sau khi đánh dấu "Bật chu kỳ đạo diễn" và lưu, đạo diễn sẽ tự động lên lịch ở lần phản hồi AI tiếp theo (vị trí chu kỳ 1).';
        return;
    }
    const lines = [];
    if (ds.planReady) {
        const planText = (ds.planAssignments || []).map((a) => `Tầng ${a.floor}→task${a.taskId}`).join('，');
        lines.push(`✅ Kế hoạch đạo diễn lần thứ ${ds.runSeq} đã sẵn sàng (${ds.planCount} nhiệm vụ)${planText ? `: ${planText}` : ''}`);
    } else {
        lines.push(`⚠️ Đạo diễn lần thứ ${ds.runSeq} tạm thời chưa có kế hoạch——Đang chờ đạo diễn chạy${ds.lastRunOk === false ? ' (Lần chạy trước thất bại, có thể thực thi lại thủ công)' : ''}`);
    }
    lines.push(`Hiện tại: Độ lệch ${ds.offset} (Số phản hồi AI kể từ lần đạo diễn trước) | Đạo diễn lần tới: Tầng ${ds.nextDirectorFloor}${ds.aggressive ? ' (Chế độ quyết liệt, khoảng cách do đạo diễn tự quyết)' : ` (Chu kỳ ${ds.cycleLength})`} | Đã kích hoạt ${ds.wokenCount || 0} | Thủ công chu kỳ này ${ds.manualRuns || 0} lần`);
    lines.push(ds.apiOverride
        ? `API Đạo diễn: Độc lập (model=${ds.apiOverride.model || 'Theo model'}｜url${ds.apiOverride.urlSet ? 'Đã ghi đè' : 'Theo'}｜key${ds.apiOverride.keySet ? 'Đã ghi đè' : 'Theo'})`
        : 'API Đạo diễn: Theo API cơ sở của RUBY (Chưa đánh dấu API Đạo diễn độc lập)');
    if (ds.lastRunOk === false && ds.lastRunReason) lines.push(`Lý do thất bại lần trước: ${h(ds.lastRunReason)}`);
    el.innerHTML = lines.join('<br>');
}

function renderDirectorView() {
    const container = $('ra_director_view');
    if (!container) return;
    const dir = ui.director || config.normalizePreset({}).director;
    ui.director = dir;
    const enabledTasks = ui.tasks.filter((t) => t.enabled);

    container.innerHTML = `
        <div class="form-section">
            <div class="form-header blue">■ Trạng thái đạo diễn <span class="director-help" data-help="Đạo diễn chạy một lần tại vị trí 1 mỗi chu kỳ và tạo lịch trình; sau đó mỗi khi đến vị trí trong kế hoạch sẽ tự động đánh thức nhiệm vụ tương ứng. Hộp trạng thái hiển thị thời gian thực về chu kỳ, vị trí hiện tại và phạm vi bao phủ của kế hoạch.">?</span></div>
            <div class="form-body">
                <div id="ra_director_status" class="status-box">Đang tải...</div>
                <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;">
                    <button id="ra_director_run" class="btn red">🎬 Thực thi lên lịch đạo diễn ngay</button>
                </div>
                <div class="tip" style="margin-top:8px;">Thực thi thủ công sẽ khiến đạo diễn lập tức quy hoạch lại chu kỳ này (đọc lại chính văn để tạo lịch trình mới), không ảnh hưởng đến các thông số chu kỳ đã lưu.</div>
            </div>
        </div>
        <div class="form-section">
            <div class="form-header blue">■ Thông số chu kỳ</div>
            <div class="form-body">
                <div class="form-row">
                    <span class="form-label">Bật chu kỳ đạo diễn <span class="director-help" data-help="Sau khi đánh dấu và lưu, đạo diễn sẽ tiếp quản việc lên lịch: Tất cả vị trí chu kỳ tĩnh của các nhiệm vụ thông thường bị bỏ qua, đạo diễn sẽ sắp xếp vị trí kích hoạt cho từng nhiệm vụ tại vị trí 1 mỗi chu kỳ; nhiệm vụ nào không được xếp lịch sẽ không chạy trong chu kỳ này. Tắt đi sẽ khôi phục lịch trình tĩnh (Dấu trang được giữ lại, không mất dữ liệu).">?</span></span>
                    <input type="checkbox" id="ra_director_enabled" class="director-enabled" ${dir.enabled ? 'checked' : ''}>
                </div>
                <div class="form-row">
                    <span class="form-label">Độ dài chu kỳ <span class="director-help" data-help="Một chu kỳ bao gồm bao nhiêu lần phản hồi AI. Đạo diễn cố định tại vị trí 1 (Sau khi bật, đạo diễn sẽ chạy ở 1-2 lần phản hồi AI tiếp theo), các nhiệm vụ do đạo diễn xếp từ vị trí 2 đến hết chu kỳ. Thay đổi độ dài chu kỳ sẽ có hiệu lực ở chu kỳ tiếp theo.">?</span></span>
                    <input type="number" id="ra_director_cycle" class="director-cycle w120" min="2" max="200" value="${dir.cycleLength}">
                    <span style="font-size:12px;color:#666;">lần phản hồi AI</span>
                </div>
                <div class="form-row">
                    <span class="form-label">Chế độ quyết liệt <span class="director-help" data-help="Sau khi đánh dấu, đạo diễn có thể tự quyết định khi nào mình xuất hiện ở lần tiếp theo: Mỗi lần lên lịch sẽ xuất thêm 'Khoảng cách đạo diễn lần tới' (bao nhiêu lần phản hồi AI sau sẽ tiếp tục đạo diễn), không còn bị ràng buộc bởi độ dài chu kỳ cố định——nơi cốt truyện dày đặc có thể đạo diễn thường xuyên, giai đoạn trải đệm có thể cách xa nhau. Đồng thời, đạo diễn sẽ nhận được hiệu suất thực tế của chu kỳ trước (số kế hoạch/số lần kích hoạt/số lần thủ công) để làm tham khảo khi lên lịch (chế độ không quyết liệt cũng nhận được).">?</span></span>
                    <input type="checkbox" id="ra_director_aggressive" class="director-aggressive" ${dir.aggressive ? 'checked' : ''}>
                </div>
                <div class="form-row">
                    <span class="form-label">Khoảng cách nhiệm vụ tối thiểu <span class="director-help" data-help="Khoảng cách tối thiểu giữa hai lần kích hoạt liền kề (Bao gồm cả vị trí 1 của đạo diễn) là bao nhiêu lần phản hồi AI. Điền 0 = Hoàn toàn do AI quyết định dựa theo nhịp độ cốt truyện; điền N = Ràng buộc cứng được ghi vào prompt của đạo diễn, khi vi phạm chỉ ghi nhận cảnh báo chứ không chặn.">?</span></span>
                    <input type="number" id="ra_director_spacing" class="director-spacing w120" min="0" max="50" value="${dir.minSpacing}">
                    <span style="font-size:12px;color:#666;">0 = Do AI quyết định</span>
                </div>
                <div class="form-row">
                    <span class="form-label">Tự động thử lại khi thất bại <span class="director-help" data-help="Số lần tự động thử lại khi định dạng đầu ra của đạo diễn bị lỗi hoặc nội dung không đầy đủ (Chỉ thử lại với lỗi dạng này; bản thân API thất bại thì không thử lại). Khi hết lượt thử lại sẽ hiện cảnh báo đỏ, chu kỳ này sẽ chạy không và chờ đến chu kỳ sau, có thể nhấp nút phía trên để thực thi lại thủ công bất cứ lúc nào.">?</span></span>
                    <input type="number" id="ra_director_retry" class="director-retry w120" min="0" max="10" value="${dir.retryLimit}">
                    <span style="font-size:12px;color:#666;">lần</span>
                </div>
                <div class="form-row">
                    <span class="form-label">Mục kế hoạch <span class="director-help" data-help="Lịch trình do đạo diễn sắp xếp được ghi vào mục worldbook chat này, mục được giữ ở trạng thái đóng, không tiêm vào hội thoại, chỉ để engine đọc và kiểm tra. Để trống sẽ không ghi vào mục nào (Lịch trình vẫn được lưu trong metadata chat, tính năng không bị ảnh hưởng).">?</span></span>
                    <input type="text" id="ra_director_plankey" class="director-plankey w250" value="${h(dir.planKey || '')}" placeholder="kế hoạch đạo diễn ruby">
                </div>
            </div>
        </div>
        <div class="form-section">
            <div class="form-header blue">■ Mục tham khảo <span class="director-help" data-help="Đánh dấu mục worldbook để đạo diễn đọc——những nội dung mà người sáng tạo cho là quan trọng đối với việc lên lịch (Thế giới quan, mối quan hệ nhân vật, v.v.) sẽ được gửi kèm prompt điều phối cho đạo diễn. Dùng chung một danh sách với kho mục tham khảo của nhiệm vụ phân tích, đánh dấu ở đây chỉ ảnh hưởng đến đạo diễn. API Đạo diễn được cấu hình ở tab phụ API của bảng người chơi.">?</span></div>
            <div class="form-body">
                <div id="ra_director_refs" class="checkbox-group">${renderDirectorRefs(dir)}</div>
            </div>
        </div>
        <div class="form-section">
            <div class="form-header blue">■ Mức ưu tiên và tóm tắt nhiệm vụ <span class="director-help" data-help="Mức ưu tiên: Số càng lớn càng ưu tiên (cùng số là cùng cấp, 0 là bình thường), đạo diễn sẽ ưu tiên sắp xếp nhiệm vụ có số lớn hơn trong điều kiện tương đương. Tóm tắt: Một câu mô tả nhiệm vụ cho đạo diễn xem, để trống sẽ tự động bắt khoảng 200 chữ xung quanh các đánh dấu 'Nhiệm vụ này là để/Mô tả nhiệm vụ' từ mục prompt của nhiệm vụ làm tóm tắt cắt ngang. Nhấp nút xem trước để kiểm tra nội dung thực tế bắt được.">?</span></div>
            <div class="form-body">
                <div id="ra_director_tasks">${renderDirectorTasks(enabledTasks)}</div>
                ${enabledTasks.length === 0 ? '<div class="tip" style="margin-top:8px;">Tạm thời chưa có nhiệm vụ được bật——Vui lòng thêm và bật nhiệm vụ ở trang cấu hình nhiệm vụ trước, đạo diễn mới có đối tượng để điều phối.</div>' : ''}
            </div>
        </div>
        <div class="btn-row" style="margin-top:12px;">
            <button id="ra_director_save" class="btn blue">💾 Lưu cấu hình đạo diễn</button>
        </div>`;
    updateDirectorStatus();
    wireDirectorViewInputs(container);
}

function collectDirectorFromUI() {
    const base = ui.director || config.normalizePreset({}).director;
    const container = $('ra_director_view');
    // Giữ nguyên giá trị hiện tại khi khung nhìn chưa được render (Hoặc đã chuyển về trang nhiệm vụ và nội dung bị xây dựng lại)
    if (!container || !container.innerHTML.trim()) return base;
    const num = (sel, def, min) => {
        const v = parseInt(container.querySelector(sel)?.value, 10);
        return Number.isFinite(v) ? Math.max(min, v) : def;
    };
    return {
        ...base,
        enabled: !!container.querySelector('.director-enabled')?.checked,
        cycleLength: num('.director-cycle', base.cycleLength, 2),
        aggressive: !!container.querySelector('.director-aggressive')?.checked,
        minSpacing: num('.director-spacing', base.minSpacing, 0),
        retryLimit: num('.director-retry', base.retryLimit, 0),
        planKey: container.querySelector('.director-plankey')?.value.trim() || '',
        useReferences: [...container.querySelectorAll('.director-ref-cb:checked')].map((el) => el.dataset.var),
    };
}

function wireDirectorViewInputs(container) {
    on(container.querySelector('.director-enabled'), 'change', (e) => {
        ui.director.enabled = e.target.checked;
        triggerAutoSave();
        engine.reinit();
        updateDirectorStatus();
    });
    on(container.querySelector('.director-cycle'), 'change', (e) => {
        ui.director.cycleLength = Math.max(2, parseInt(e.target.value, 10) || 20);
        e.target.value = ui.director.cycleLength;
        triggerAutoSave();
        engine.reinit();
    });
    on(container.querySelector('.director-aggressive'), 'change', (e) => {
        ui.director.aggressive = e.target.checked;
        triggerAutoSave();
    });
    on(container.querySelector('.director-spacing'), 'change', (e) => {
        ui.director.minSpacing = Math.max(0, parseInt(e.target.value, 10) || 0);
        e.target.value = ui.director.minSpacing;
        triggerAutoSave();
    });
    on(container.querySelector('.director-retry'), 'change', (e) => {
        ui.director.retryLimit = Math.max(0, parseInt(e.target.value, 10) || 0);
        e.target.value = ui.director.retryLimit;
        triggerAutoSave();
    });
    on(container.querySelector('.director-plankey'), 'change', (e) => {
        ui.director.planKey = e.target.value.trim();
        triggerAutoSave();
    });
    container.querySelectorAll('.director-ref-cb').forEach((cb) => on(cb, 'change', () => {
        ui.director.useReferences = [...container.querySelectorAll('.director-ref-cb:checked')].map((el) => el.dataset.var);
        triggerAutoSave();
    }));
    container.querySelectorAll('.director-priority').forEach((input) => on(input, 'change', () => {
        const t = ui.tasks.find((x) => x.id === parseInt(input.dataset.id, 10));
        if (t) t.directorPriority = Math.max(0, Math.round(Number(input.value) || 0));
        triggerAutoSave();
    }));
    container.querySelectorAll('.director-summary').forEach((input) => on(input, 'change', () => {
        const t = ui.tasks.find((x) => x.id === parseInt(input.dataset.id, 10));
        if (t) t.directorSummary = input.value;
        triggerAutoSave();
    }));
    on($('ra_director_run'), 'click', async () => {
        try {
            ui.director = collectDirectorFromUI();
            await saveCurrentSchemeFromUI();
            await engine.forceRun('director');
        } catch (e) {
            window.toastr?.error?.(e.message);
        }
        updateDirectorStatus();
    });
    on($('ra_director_save'), 'click', async () => {
        try {
            if (!config.getCharacterIdentity()) {
                window.toastr?.warning?.('⚠️ Chưa mở thẻ nhân vật: Cấu hình đạo diễn được lưu ở lớp toàn cục, sẽ không được xuất theo thẻ nhân vật');
            }
            ui.director = collectDirectorFromUI();
            await saveCurrentSchemeFromUI();
            config.flushCardPersistNow().catch(() => { /* flush nội bộ đã báo cáo lỗi */ });
            engine.reinit();
            window.toastr?.success?.('Đã lưu cấu hình đạo diễn');
        } catch (e) {
            window.toastr?.error?.('Lưu thất bại: ' + e.message);
        }
        updateDirectorStatus();
    });
    container.querySelectorAll('.director-brief-preview').forEach((btn) => on(btn, 'click', async (e) => {
        e.stopPropagation();
        const task = ui.tasks.find((x) => x.id === parseInt(btn.dataset.id, 10));
        if (!task) return;
        let title = '';
        let text = '';
        if (String(task.directorSummary || '').trim()) {
            title = '✍️ Tóm tắt thủ công (Ưu tiên sử dụng)';
            text = task.directorSummary;
        } else {
            try {
                const charBook = await worldbook.getCharBookName();
                const chatBook = await worldbook.getChatBookName();
                const content = task.promptKey ? await worldbook.readEntry(charBook, chatBook, task.promptKey, true) : '';
                const brief = director.extractTaskBrief(content);
                if (brief) {
                    title = '🔍 Tự động trích xuất tóm tắt';
                    text = brief;
                } else {
                    title = '⚠️ Không bắt được tóm tắt';
                    text = task.promptKey
                        ? 'Nội dung mục prompt trống, hoặc không chứa các đánh dấu "Nhiệm vụ này là để/Mô tả nhiệm vụ"——Đạo diễn sẽ chỉ nhận được tên nhiệm vụ.'
                        : 'Nhiệm vụ này chưa được cấu hình mục prompt——Đạo diễn sẽ chỉ nhận được tên nhiệm vụ.';
                }
            } catch (err) {
                title = '⚠️ Trích xuất thất bại';
                text = String(err?.message || err);
            }
        }
        showBriefPopup(btn, `#${task.id} ${task.displayName || ''}`, title, text);
    }));
}

/** Cửa sổ xem trước tóm tắt: Hiển thị nội dung tóm tắt thực tế mà đạo diễn sẽ nhận được, nhấp ra chỗ khác để đóng */
function showBriefPopup(anchor, taskLabel, title, text) {
    document.getElementById('ra_director_brief_pop')?.remove();
    const pop = document.createElement('div');
    pop.id = 'ra_director_brief_pop';
    pop.innerHTML = `
        <div class="brief-pop-title">${h(taskLabel)}·Xem trước tóm tắt</div>
        <div class="brief-pop-sub">${h(title)}</div>
        <div class="brief-pop-body"></div>`;
    pop.querySelector('.brief-pop-body').textContent = text;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 340))}px`;
    pop.style.top = `${Math.min(r.bottom + 6, Math.max(8, window.innerHeight - 260))}px`;
    const close = (e) => {
        if (pop.contains(e.target)) return;
        pop.remove();
        document.removeEventListener('click', close);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
}

function setDirectorView(active) {
    ui.directorViewActive = active;
    const tasksView = $('ra_tasks_view');
    const dirView = $('ra_director_view');
    const flipBtn = $('ra_director_flip');
    if (!tasksView || !dirView) return;
    tasksView.style.display = active ? 'none' : '';
    dirView.style.display = active ? '' : 'none';
    if (flipBtn) {
        flipBtn.textContent = active ? '⬅ Quay lại cấu hình nhiệm vụ' : '🎬 Chế độ đạo diễn';
        // Hiệu ứng nhịp đập chỉ phát trong trạng thái "Vào chế độ đạo diễn", nút quay lại sẽ giữ yên tĩnh
        flipBtn.classList.toggle('director-enter', !active);
    }
    if (active) renderDirectorView();
}

/** Đấu nối một lần cho điều khiển Chế độ đạo diễn: Nút lật, Cửa sổ bật lên trợ giúp ? (Nhấp để bật lên/Nhấp chỗ khác để đóng), Làm mới liên kết trạng thái engine */
function wireDirectorControls() {
    on($('ra_director_flip'), 'click', () => setDirectorView(!ui.directorViewActive));
    document.addEventListener('click', (e) => {
        const tip = e.target?.closest?.('.director-help');
        const existing = $('ra_director_help_pop');
        if (!tip) {
            if (existing) existing.remove();
            return;
        }
        e.stopPropagation();
        if (existing) existing.remove();
        const pop = document.createElement('div');
        pop.id = 'ra_director_help_pop';
        pop.textContent = tip.dataset.help || '';
        document.body.appendChild(pop);
        const r = tip.getBoundingClientRect();
        pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`;
        pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 140)}px`;
    });
    engine.onStateChange(() => {
        if (ui.directorViewActive) updateDirectorStatus();
        // Dòng thời gian người sáng tạo + Lịch trình nhiệm vụ người chơi đều theo dõi động kế hoạch đạo diễn
        renderCycleInfo();
        renderScheduleFromState();
        updateDirectorApiHighlight();
    });
}

/** Render lại lịch trình kích hoạt nhiệm vụ trên bảng điều khiển chính của người chơi theo trạng thái cấu hình hiện tại (Liên kết khi trạng thái engine thay đổi) */
function renderScheduleFromState() {
    const { data, layer } = config.resolveConfig();
    renderSchedule(data, layer);
}

function renderSchemeTabs() {
    const container = $('ra_scheme_tabs');
    if (!container) return;
    const { data } = config.resolveConfig();
    const presets = data.presets || [];
    const activeId = data.activePresetId;

    let html = '';
    for (const preset of presets) {
        const isEditing = preset.id === ui.editingPresetId;
        const isActive = preset.id === activeId;
        html += `
            <div class="scheme-tab ${isEditing ? 'active' : ''}" data-id="${h(preset.id)}">
                <span class="scheme-name">${h(preset.name || 'Chưa đặt tên')}</span>
                ${isActive ? '<span class="scheme-badge">Hiện tại</span>' : ''}
            </div>`;
    }
    html += '<button class="scheme-tab-add" id="ra_add_scheme_tab_btn" title="Thêm phương án mới">➕</button>';
    container.innerHTML = html;

    container.querySelectorAll('.scheme-tab').forEach((tab) => {
        on(tab, 'click', async () => {
            const presetId = tab.dataset.id;
            if (presetId === ui.editingPresetId) return;
            await saveCurrentSchemeFromUI();
            loadSchemeToUI(presetId);
            renderSchemeTabs();
        });
    });

    on($('ra_add_scheme_tab_btn'), 'click', async () => {
        await saveCurrentSchemeFromUI();
        const { data: currentData } = config.resolveConfig();
        const existingCount = currentData.presets?.length || 0;
        const numberStrings = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
        const newName = existingCount < 10 ? `Phương án ${numberStrings[existingCount]}` : `Phương án ${existingCount + 1}`;
        const newId = `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const newPreset = config.makeDefaultPreset();
        newPreset.id = newId;
        newPreset.name = newName;

        currentData.presets = [...currentData.presets, newPreset];
        config.saveConfigData(currentData);

        ui.editingPresetId = newId;
        loadSchemeToUI(newId);
        renderSchemeTabs();
        window.toastr?.success?.(`Đã tạo phương án mới: ${newName}`);
    });
}

let autoSaveTimer = null;
let lastSaveTime = 0;
let uiFullyInitialized = false;
const AUTO_SAVE_DELAY = 800;
const MIN_SAVE_INTERVAL = 3000;

function triggerAutoSave() {
    if (!uiFullyInitialized) return;
    const now = Date.now();
    if (now - lastSaveTime < MIN_SAVE_INTERVAL) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        try {
            if (!uiFullyInitialized) return;
            const taskCards = document.querySelectorAll('.task-card[data-id]');
            if (ui.tasks.length > 0 && taskCards.length === 0) return;
            await saveCurrentSchemeFromUI();
            lastSaveTime = Date.now();
        } catch (e) {
            log('auto save failed:', e);
        }
    }, AUTO_SAVE_DELAY);
}

function wireTaskControls() {
    on($('ra_add_task_area'), 'click', () => {
        if (!config.getCharacterIdentity()) {
            window.toastr?.warning?.('⚠️ Chưa mở thẻ nhân vật: Nhiệm vụ sẽ được lưu tạm ở lớp toàn cục, sẽ không được xuất theo thẻ nhân vật. Khuyên bạn nên mở thẻ nhân vật rồi mới cấu hình');
        }
        ui.tasks = collectTasksFromUI();
        // Nhiệm vụ mới tạo mặc định chọn thư viện ràng buộc tích hợp; khi tồn tại mục người dùng có cùng từ khóa (mục tích hợp bị che khuất) thì mặc định chọn mục của người dùng
        const defaultRefVars = [];
        for (const b of BUILTIN_REFERENCES) {
            const shadowKey = findShadowingKey(b, (ui.refs || []).map((r) => r.entryKey));
            const shadowRef = shadowKey ? (ui.refs || []).find((r) => String(r.entryKey || '') === shadowKey) : null;
            const varName = shadowRef?.varName || b.varName;
            if (varName && !defaultRefVars.includes(varName)) defaultRefVars.push(varName);
        }
        const newTask = config.normalizeTask({
            id: ui.nextTaskId++,
            enabled: true,
            displayName: `Nhiệm vụ ${ui.tasks.length + 1}`,
            cyclePositions: [10],
            outputVarName: `task_${ui.nextTaskId - 1}_Output`,
            useReferences: defaultRefVars,
        });
        ui.tasks.push(newTask);
        ui.expandedTasks.add(newTask.id);
        renderTaskSlots();
        renderCycleInfo();
        requestAnimationFrame(() => {
            const card = $('ra_task_slots')?.querySelector(`.task-card[data-id="${newTask.id}"]`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        window.toastr?.success?.(`Đã thêm nhiệm vụ #${newTask.id} (Các nội dung nhiệm vụ khác đã điền được giữ nguyên)`);
    });

    on($('ra_tasks_save'), 'click', async () => {
        try {
            if (!config.getCharacterIdentity()) {
                window.toastr?.warning?.('⚠️ Chưa mở thẻ nhân vật: Cấu hình được lưu ở lớp toàn cục, sẽ không được xuất theo thẻ nhân vật');
            }
            await saveCurrentSchemeFromUI();
            config.flushCardPersistNow().catch(() => { /* flush nội bộ đã báo cáo lỗi */ });
            window.toastr?.success?.('Đã lưu cấu hình phương án hiện tại');
            reinitEngineIfNeeded();
            refreshAll();
        } catch (e) {
            window.toastr?.error?.('Lưu thất bại: ' + e.message);
        }
    });

    on($('ra_tasks_reset'), 'click', () => {
        if (!window.confirm('Bạn có chắc muốn xóa sạch tất cả nhiệm vụ không? Thao tác này không thể khôi phục.')) return;
        ui.tasks = [];
        ui.nextTaskId = 1;
        renderTaskSlots();
        renderCycleInfo();
        window.toastr?.info?.('Đã xóa sạch tất cả nhiệm vụ');
    });

    on($('ra_scheme_name_input'), 'change', async () => {
        const newName = $('ra_scheme_name_input')?.value.trim();
        if (!newName) return;
        await saveCurrentSchemeFromUI();
        renderSchemeTabs();
    });

    on($('ra_scheme_activate_btn'), 'click', async () => {
        const { data } = config.resolveConfig();
        if (ui.editingPresetId === data.activePresetId) {
            window.toastr?.info?.('Phương án này đã ở trạng thái kích hoạt hiện tại');
            return;
        }
        const preset = data.presets.find((p) => p.id === ui.editingPresetId);
        if (!window.confirm(`Bạn có chắc muốn đặt "${preset?.name || ui.editingPresetId}" làm phương án sử dụng hiện tại không?`)) return;
        withConfigData((d) => { d.activePresetId = ui.editingPresetId; });
        window.toastr?.success?.('Đã kích hoạt phương án này');
        reinitEngineIfNeeded();
        renderSchemeTabs();
        loadSchemeToUI(ui.editingPresetId);
        refreshAll();
    });

    on($('ra_scheme_delete_btn'), 'click', async () => {
        const { data } = config.resolveConfig();
        if (data.presets.length <= 1) {
            window.toastr?.warning?.('Cần giữ lại ít nhất một phương án');
            return;
        }
        const preset = data.presets.find((p) => p.id === ui.editingPresetId);
        if (!window.confirm(`Bạn có chắc muốn xóa phương án "${preset?.name || ui.editingPresetId}" không? Thao tác này không thể khôi phục.`)) return;
        await saveCurrentSchemeFromUI();
        const { data: fresh } = config.resolveConfig();
        const newPresets = fresh.presets.filter((p) => p.id !== ui.editingPresetId);
        let newActiveId = fresh.activePresetId;
        if (ui.editingPresetId === fresh.activePresetId) {
            newActiveId = newPresets[0]?.id || 'default';
        }
        fresh.presets = newPresets;
        fresh.activePresetId = newActiveId;
        config.saveConfigData(fresh);

        ui.editingPresetId = newPresets[0]?.id || 'default';
        loadSchemeToUI(ui.editingPresetId);
        renderSchemeTabs();
        window.toastr?.info?.('Đã xóa phương án');
        reinitEngineIfNeeded();
        refreshAll();
    });

    const schemeArea = $('ra_scheme_area');
    if (schemeArea) {
        schemeArea.addEventListener('focusout', () => triggerAutoSave());
        schemeArea.addEventListener('change', (e) => {
            if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') {
                triggerAutoSave();
            }
        });
    }
    setTimeout(() => { uiFullyInitialized = true; }, 1200);
}

function renderBindingTab(layer) {
    const statusEl = $('ra_binding_status');
    const listEl = $('ra_bound_list');
    if (!statusEl) return;

    const identity = config.getCharacterIdentity();
    if (!identity) {
        statusEl.innerHTML = '<span class="status-warn">⚠ Vui lòng mở một cuộc trò chuyện với nhân vật trước (thẻ nhân vật) —— Cấu hình RUBY được lưu trong thẻ nhân vật, chưa mở thẻ nhân vật thì không thể liên kết</span>';
    } else {
        const { source } = config.resolveConfig();
        const bound = layer === 'character';
        const layerLabel = !bound
            ? '<span class="status-warn">Toàn cục (Chưa liên kết thẻ nhân vật ⚠️) —— Lưu sửa đổi sẽ tự động liên kết với thẻ nhân vật hiện tại, hoặc nhấp vào nút bên dưới để liên kết ngay</span>'
            : (source === 'card'
                ? '<span class="status-ok">Nhúng trong thẻ nhân vật ✓ (Cấu hình đã được ghi vào data.extensions của thẻ nhân vật, xuất/chia sẻ theo thẻ)</span>'
                : '<span class="status-warn">Lưu trữ phiên bản cũ cục bộ (Chỉ tồn tại trong settings.json của máy) —— Lưu sửa đổi sẽ tự động di chuyển và ghi vào thẻ nhân vật</span>');
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <span style="font-size:22px;">${bound ? (source === 'card' ? '📇' : '🔗') : '🌍'}</span>
                <div>
                    <div style="font-weight:700;font-size:15px;">Nhân vật hiện tại: ${h(identity.name)}</div>
                    <div style="font-size:13px;margin-top:4px;">
                        Lớp cấu hình: <strong>${layerLabel}</strong>
                    </div>
                </div>
            </div>`;
    }

    if (listEl) {
        const boundChars = config.getBoundCharacters();
        listEl.innerHTML = boundChars.length > 0
            ? boundChars.map((c) => `<div style="padding:6px 0;border-bottom:1px dashed #ddd;">${c.source === 'card' ? '📇' : '💾'} ${h(c.name)} <span style="color:#999;font-size:12px;">(${c.source === 'card' ? 'Nhúng trong thẻ nhân vật' : 'Phiên bản cũ cục bộ'})</span></div>`).join('')
            : '<span style="color:#666;">Tạm thời chưa có liên kết nhân vật, tất cả nhân vật sử dụng cấu hình toàn cục</span>';
    }
}

function wireBindingControls() {
    on($('ra_bind_btn'), 'click', () => {
        if (!config.getCharacterIdentity()) {
            window.toastr?.warning?.('Vui lòng mở một cuộc trò chuyện với nhân vật trước (thẻ nhân vật)');
            return;
        }
        if (config.bindToCharacter()) {
            window.toastr?.success?.('Đã ghi cấu hình hiện tại vào thẻ nhân vật và liên kết (Xuất theo thẻ)');
            reinitEngineIfNeeded();
            refreshAll();
        }
    });
}

function renderPresetSummary() {
    const el = $('ra_preset_summary');
    if (!el) return;
    const { data } = config.resolveConfig();
    const presets = data.presets || [];
    const tagCount = (data.customContentTags || []).length;

    let totalTasks = 0;
    let totalRefs = 0;
    for (const preset of presets) {
        totalTasks += (preset.tasks || []).length;
        totalRefs += (preset.referencePool || []).length;
    }

    let html = `
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px;">
            <div>📦 Phương án cấu hình: <strong>${presets.length}</strong></div>
            <div>🏷️ Thẻ tùy chỉnh: <strong>${tagCount}</strong></div>
            <div>📋 Tổng số nhiệm vụ: <strong>${totalTasks}</strong></div>
            <div>📚 Tổng số mục tham khảo: <strong>${totalRefs}</strong></div>
        </div>
        <div style="border-top:1px dashed #999;padding-top:12px;">
        <div style="font-weight:700;margin-bottom:8px;">📋 Danh sách phương án:</div>`;

    for (const preset of presets) {
        const isActive = preset.id === data.activePresetId;
        const taskCount = (preset.tasks || []).length;
        const enabledTasks = (preset.tasks || []).filter((t) => t.enabled).length;
        const refCount = (preset.referencePool || []).length;
        html += `
            <div class="preset-summary-card ${isActive ? 'active' : ''}">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <span style="font-weight:700;font-size:14px;">${h(preset.name || 'Chưa đặt tên')}</span>
                    ${isActive ? '<span style="background:#2C5530;color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;">Đang kích hoạt</span>' : ''}
                </div>
                <div class="preset-summary-meta">📋 ${taskCount} nhiệm vụ (${enabledTasks} đang bật) · 📚 ${refCount} mục tham khảo</div>
            </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
}

/** Xóa khóa bí mật trước khi xuất (Phòng thủ chiều sâu): Loại bỏ đệ quy tất cả các trường thuộc loại khóa bí mật, ngay cả khi tương lai cấu hình vô tình chứa khóa bí mật thì cũng tuyệt đối không xuất theo mẫu */
function scrubSecretsForExport(value, keyName = '') {
    if (Array.isArray(value)) return value.map((v) => scrubSecretsForExport(v));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (/^(key|apikey|api_key|proxy_password|password|token|secret)$/i.test(k)) continue;
            out[k] = scrubSecretsForExport(v, k);
        }
        return out;
    }
    return value;
}

function generateExportData() {
    const { data } = config.resolveConfig();
    return {
        _meta: {
            type: 'RUBY_ANALYZER_PRESET',
            version: '3.0.0',
            exportTime: new Date().toISOString(),
            description: 'Mẫu cấu hình do hệ thống phân tích RUBY xuất ra (Gồm nhiều phương án; các trường dạng khóa/mật khẩu đã được xóa trước khi xuất)',
            presetCount: (data.presets || []).length,
        },
        charName: data.charName || '',
        customContentTags: data.customContentTags || [],
        summaryProvider: data.summaryProvider || '',
        yuzukiIncludePlot: data.yuzukiIncludePlot !== false,
        jailbreak: jailbreak.normalizeJailbreakConfig(data.jailbreak),
        gen: data.gen || {},
        activePresetId: data.activePresetId,
        presets: scrubSecretsForExport(data.presets),
    };
}

function wirePresetIoControls() {
    on($('ra_preset_export'), 'click', () => {
        try {
            const exportData = generateExportData();
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ruby_analyzer_config_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            window.toastr?.success?.('Đã xuất mẫu cấu hình');
        } catch (e) {
            window.toastr?.error?.('Xuất thất bại: ' + e.message);
        }
    });

    on($('ra_preset_import'), 'click', () => {
        $('ra_preset_file_input')?.click();
    });

    on($('ra_preset_file_input'), 'change', async (e) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        if (!config.getCharacterIdentity()) {
            window.toastr?.warning?.('Vui lòng mở thẻ nhân vật trước: Cấu hình được nhập sẽ tự động liên kết với thẻ nhân vật hiện tại');
            e.target.value = '';
            return;
        }
        try {
            const text = await file.text();
            const raw = JSON.parse(text);
            const parsed = config.parseImportTemplate(raw);
            if (!window.confirm(`Bạn có chắc muốn nhập "${file.name}" không? (Phiên bản nguồn ${parsed.sourceVersion}, gồm ${parsed.presetCount} phương án, ${parsed.taskCount} nhiệm vụ). Sau khi nhập, cấu hình sẽ tự động liên kết với thẻ nhân vật hiện tại, các phương án hiện có trong thẻ sẽ bị ghi đè.`)) return;

            withConfigData((d) => {
                d.charName = parsed.charName;
                d.customContentTags = parsed.customContentTags;
                d.summaryProvider = parsed.summaryProvider;
                d.yuzukiIncludePlot = parsed.yuzukiIncludePlot !== false;
                d.jailbreak = parsed.jailbreak;
                d.gen = parsed.gen;
                d.presets = parsed.presets;
                d.activePresetId = parsed.activePresetId;
            });
            config.flushCardPersistNow().catch(() => { /* flush nội bộ đã báo cáo lỗi */ });

            ui.importedTemplateName = file.name;
            $('ra_template_info').innerHTML = `
                <div style="font-weight:700;margin-bottom:6px;">📄 ${h(file.name)}</div>
                <div style="font-size:12px;color:#666;">
                    Phiên bản nguồn: ${h(parsed.sourceVersion)} · Thời gian xuất: ${h(parsed.sourceTime || 'Không rõ')}<br>
                    Đã nhập: ${parsed.presetCount} phương án · ${parsed.taskCount} nhiệm vụ
                </div>`;
            window.toastr?.success?.(`Đã nhập mẫu cấu hình (${parsed.presetCount} phương án, ${parsed.taskCount} nhiệm vụ)`);
            reinitEngineIfNeeded();
            refreshAll();
        } catch (err) {
            window.toastr?.error?.('Nhập thất bại: ' + err.message);
        } finally {
            e.target.value = '';
        }
    });

    on($('ra_preset_validate'), 'click', async () => {
        const resultEl = $('ra_validate_result');
        if (!resultEl) return;
        try {
            const { data } = config.resolveConfig();
            const preset = config.getActivePreset(data);
            const entries = [];
            for (const ref of preset.referencePool || []) {
                if (ref.entryKey) entries.push({ key: ref.entryKey, label: ref.label || ref.varName, type: 'Tham khảo' });
            }
            for (const task of preset.tasks || []) {
                if (task.promptKey) entries.push({ key: task.promptKey, label: `Prompt ${task.displayName || `Nhiệm vụ#${task.id}`}`, type: 'Prompt' });
                if (task.outputKey) entries.push({ key: task.outputKey, label: `Đầu ra ${task.displayName || `Nhiệm vụ#${task.id}`}`, type: 'Đầu ra' });
            }

            if (entries.length === 0) {
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<span class="status-warn">Phương án hiện tại không được cấu hình bất kỳ phụ thuộc mục nào</span>';
                return;
            }

            const charBook = await worldbook.getCharBookName();
            const chatBook = await worldbook.getChatBookName();
            if (!charBook) {
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<span class="status-err">Không tìm thấy worldbook của nhân vật</span>';
                return;
            }

            const lines = [];
            for (const e of entries) {
                let found = false;
                try {
                    found = await worldbook.entryExists(charBook, e.key);
                    if (!found && chatBook) found = await worldbook.entryExists(chatBook, e.key);
                } catch { /* treat as missing */ }
                const isOutput = e.type === 'Đầu ra';
                const cls = found ? 'status-ok' : (isOutput ? 'status-warn' : 'status-err');
                const mark = found ? '✓' : (isOutput ? '⚠ (Sẽ được tự động tạo khi phân tích)' : '✕ Thiếu');
                lines.push(`<span class="${cls}">${mark} [${e.type}] ${h(e.label)}</span>`);
            }
            resultEl.style.display = 'block';
            resultEl.innerHTML = lines.join('<br>');
        } catch (err) {
            resultEl.style.display = 'block';
            resultEl.innerHTML = `<span class="status-err">Kiểm tra thất bại: ${h(err.message)}</span>`;
        }
    });
}

// ---------- Trang tab Chế độ Viết thẻ ----------

const cwLogLines = [];

function cwPushLog(text) {
    const time = new Date().toTimeString().slice(0, 8);
    cwLogLines.unshift(`[${time}] ${text}`);
    if (cwLogLines.length > 60) cwLogLines.pop();
    const el = $('ra_cw_log');
    if (el) el.innerHTML = cwLogLines.map((l) => h(l)).join('<br>');
}

function renderCardWriterTab() {
    const s = cardwriter.getState();
    const statusEl = $('ra_cw_status');
    if (statusEl) {
        const modeLabel = cardwriter.getSettings().mode === 'dialogue' ? '💬 Chế độ đối thoại' : '⚡ Chế độ nhanh';
        const stepLine = s.active
            ? `Bước hiện tại: <strong>${h(s.stepId || '—')}</strong> ${s.stepId ? `(${h(s.stepName)})` : ''}`
            : 'Chưa kích hoạt';
        statusEl.innerHTML = `
            <div>${s.active ? '<span class="status-ok">🟢 Phiên viết thẻ đang diễn ra</span>' : '<span class="status-warn">⚪ Chưa kích hoạt</span>'} · ${modeLabel}</div>
            <div style="margin-top:6px;">${stepLine}</div>
            <div style="margin-top:6px;font-size:12px;color:#666;">
                Số bản nháp: ${s.draftCount} · Thao tác gần đây: ${h(s.lastAction || 'Không')}${s.lastError ? `<br><span class="status-err">Lỗi: ${h(s.lastError)}</span>` : ''}
            </div>`;
    }

    const stepsEl = $('ra_cw_steps');
    if (stepsEl) {
        const steps = cardwriter.getSteps();
        stepsEl.innerHTML = steps.map((st) => {
            const isCur = s.active && s.stepId === st.id;
            const cls = isCur ? 'cw-step cur' : 'cw-step';
            const tag = st.id === 'Overview' ? '🏁Hoàn tất' : (st.tool ? '🔧Công cụ' : (st.optional ? '◇Tùy chọn' : ''));
            return `<button class="${cls}" data-step="${h(st.id)}" title="Chuyển sang ${h(st.id)} ${h(st.name)}">${isCur ? '✦ ' : ''}${h(st.id === 'Overview' ? '' : st.id + ' ')}${h(st.name)}${tag ? ` <span class="cw-tag">${tag}</span>` : ''}</button>`;
        }).join('');
        stepsEl.querySelectorAll('.cw-step').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!cardwriter.getState().active) {
                    window.toastr?.warning?.('Vui lòng bắt đầu phiên viết thẻ trước');
                    return;
                }
                const ok = await cardwriter.switchStep(btn.dataset.step, { manual: true });
                if (ok) {
                    cwPushLog(`Chuyển bước thủ công → ${btn.dataset.step}`);
                    renderCardWriterTab();
                }
            });
        });
    }
}

function wireCardWriterControls() {
    const settings = cardwriter.getSettings();
    const draftEl = $('ra_cw_draft');
    const guideEl = $('ra_cw_guide');
    if (draftEl) draftEl.checked = settings.draftToBook;
    if (guideEl) guideEl.checked = settings.showGuide;
    const modeFast = document.querySelector('#ra_panel input[name="ra_cw_mode"][value="fast"]');
    const modeDialogue = document.querySelector('#ra_panel input[name="ra_cw_mode"][value="dialogue"]');
    if (modeFast) modeFast.checked = settings.mode !== 'dialogue';
    if (modeDialogue) modeDialogue.checked = settings.mode === 'dialogue';
    const modeRadios = [modeFast, modeDialogue].filter(Boolean);
    for (const radio of modeRadios) {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            cardwriter.saveSettings({ mode: radio.value });
            cwPushLog(`Chuyển đổi chế độ: ${radio.value === 'dialogue' ? 'Chế độ đối thoại' : 'Chế độ nhanh'}`);
        });
    }

    on($('ra_cw_start'), 'click', async () => {
        if (await cardwriter.startSession('Step0')) {
            cwPushLog('Bắt đầu phiên viết thẻ → Step0');
            renderCardWriterTab();
        }
    });
    on($('ra_cw_end'), 'click', async () => {
        if (await cardwriter.endSession({ keepDrafts: true })) {
            cwPushLog('Kết thúc phiên (Giữ lại bản nháp)');
            renderCardWriterTab();
        }
    });
    on($('ra_cw_end_clear'), 'click', async () => {
        if (!window.confirm('Bạn có chắc muốn xóa sạch các mục viết thẻ không? Sẽ xóa các mục bước và bản nháp do RUBY tạo trong worldbook chat (Các mục khác không bị ảnh hưởng).')) return;
        if (await cardwriter.endSession({ keepDrafts: false })) {
            cwPushLog('Kết thúc phiên (Xóa sạch mục)');
            renderCardWriterTab();
        }
    });
    on($('ra_cw_open_book'), 'click', async () => {
        await cardwriter.openDraftBook();
        cwPushLog('Mở worldbook "ruby viết thẻ bản nháp"');
    });
    on(draftEl, 'change', () => {
        cardwriter.saveSettings({ draftToBook: !!draftEl.checked });
        cwPushLog(`Ghi bản nháp: ${draftEl.checked ? 'Bật' : 'Tắt'}`);
    });
    on(guideEl, 'change', () => {
        cardwriter.saveSettings({ showGuide: !!guideEl.checked });
        cwPushLog(`Tiêm hướng dẫn bước: ${guideEl.checked ? 'Bật' : 'Tắt'}`);
    });

    cardwriter.onStateChange((s) => {
        cwPushLog(s.lastAction || s.stepId || 'Cập nhật trạng thái');
        renderCardWriterTab();
    });
    window.addEventListener('ruby:cardwriter-draft', (e) => {
        cwPushLog(`Ghi bản nháp: ${e.detail?.stepId} → ${e.detail?.key}`);
    });

    renderCardWriterTab();
}