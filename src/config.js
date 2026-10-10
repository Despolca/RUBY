import { ctx, log, warn } from './env.js';

const SETTINGS_KEY = 'RubyAnalyzer';

export const DEFAULT_STARTUP = {
    enabled: false,
    displayName: 'Phân tích mở màn',
    triggerFloors: [1, 2],
    cyclePositions: [1, 2],
    promptKey: '',
    outputKey: '',
    extraKeys: '',
    outputVarName: 'startupOutput',
    enableJailbreak: true,
    outputConstant: false,
    outputDisable: 0,
    selective: false,
    selectiveKeysEnabled: false,
    selectiveKeys: [],
    noRecursion: false,
    position: 0,
    depth: 4,
    order: 100,
    useReferences: [],
    useOutputs: [],
    keywordScanEnabled: false,
    keywordScanKeywords: [],
    characters: [],
};

export const DEFAULT_DIRECTOR = {
    enabled: false,
    displayName: 'Chế độ đạo diễn',
    cycleLength: 20,        // Độ dài chu kỳ (số lần AI phản hồi); đạo diễn luôn nằm ở vị trí chu kỳ 1
    aggressive: false,      // Chế độ quyết liệt: Đạo diễn tự quyết định thời gian xuất hiện lần tới (xuất ra "Khoảng cách đạo diễn lần tới")
    minSpacing: 0,          // Khoảng cách nhiệm vụ tối thiểu (số lần AI phản hồi); 0 = Hoàn toàn do AI quyết định
    retryLimit: 2,          // Số lần tự động thử lại khi định dạng đầu ra của đạo diễn bị lộn xộn/không hoàn chỉnh
    planKey: 'Kế hoạch đạo diễn ruby', // Mục Worldbook trò chuyện nơi ghi lại kế hoạch điều phối (giữ trạng thái đóng, chỉ dành cho engine đọc)
    useReferences: [],      // Bể mục tham khảo mà đạo diễn có thể tick chọn
};

const makeDefaultDirectorApi = () => ({
    enabled: false,         // Phía người chơi tick chọn: API đạo diễn độc lập (khuyên dùng mô hình có IQ cao hơn)
    url: '',                // Trống = Đi theo địa chỉ API phân tích của RUBY
    key: '',                // Trống = Đi theo khóa API phân tích của RUBY
    model: '',              // Trống = Đi theo mô hình API phân tích của RUBY
});

export const makeDefaultPreset = () => ({
    id: 'default',
    name: 'Phương án mặc định',
    description: '',
    referencePool: [],
    tasks: [],
    nextTaskId: 1,
    startupTask: JSON.parse(JSON.stringify(DEFAULT_STARTUP)),
    director: JSON.parse(JSON.stringify(DEFAULT_DIRECTOR)),
});

export const makeDefaultConfigData = () => ({
    charName: '',
    customContentTags: [],
    summaryProvider: '',
    presets: [makeDefaultPreset()],
    activePresetId: 'default',
    jailbreak: null,
    gen: {},
});

const makeDefaultApi = () => ({
    provider: 'main',
    url: '',
    key: '',
    model: '',
    stream: true,
    cache: [],
    reasoningEffort: '',
});

const makeDefaultUi = () => ({
    orbHidden: false,
    orbSize: 60,
    orbX: null,
    orbY: null,
    notify: true,
    // Chế độ ban đêm: true/false = người dùng chọn rõ ràng; null = chưa thiết lập (đi theo giao diện hệ thống)
    darkMode: null,
});

/** Phạm vi kích thước quả cầu lơ lửng: Cửa sổ lơ lửng hiện tại giới hạn trên là 60px, có thể thu nhỏ dần */
export function clampOrbSize(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 60;
    return Math.max(32, Math.min(60, Math.round(v)));
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Làm sạch tham số sinh văn bản: Chỉ giữ lại giá trị hợp lệ, còn lại loại bỏ hết (không gửi, giao cho preset của Tavern/mặc định của nhà cung cấp xử lý).
 * Cờ enabled ở cấp cao nhất mặc định đóng - Khi đóng, engine hoàn toàn không truyền tham số lấy mẫu.
 */
export function sanitizeGenParams(gen) {
    const src = (gen && typeof gen === 'object') ? gen : {};
    const rules = {
        temperature: { min: 0, max: 2 },
        top_p: { min: 0, max: 1, exclusiveMin: true },
        top_k: { min: 1, max: 1000 },
        presence_penalty: { min: -2, max: 2 },
        frequency_penalty: { min: -2, max: 2 },
    };
    const out = {};
    for (const [key, rule] of Object.entries(rules)) {
        const n = Number(src[key]);
        if (!Number.isFinite(n)) continue;
        if (n < rule.min || n > rule.max) continue;
        if (rule.exclusiveMin && n <= rule.min) continue;
        out[key] = n;
    }
    const mt = Number(src.max_tokens);
    if (Number.isFinite(mt) && mt >= 1) out.max_tokens = mt;
    if (['low', 'medium', 'high'].includes(String(src.reasoning_effort))) {
        out.reasoning_effort = String(src.reasoning_effort);
    }
    if (src.enabled === true) out.enabled = true;
    return out;
}

export function getSettings() {
    const c = ctx();
    if (!c) return null;
    const store = (c.extensionSettings[SETTINGS_KEY] ||= {});
    store.api = { ...makeDefaultApi(), ...(store.api || {}) };
    store.api.cache = Array.isArray(store.api.cache) ? store.api.cache : [];
    const rawProvider = String(store.api.provider || '');
    if (rawProvider !== 'main' && rawProvider !== 'custom') {
        store.api.provider = (rawProvider === 'st' || rawProvider === '') && !store.api.url ? 'main' : 'custom';
    }
    store.global = normalizeConfigData(store.global || makeDefaultConfigData());
    store.characterConfigs = (store.characterConfigs && typeof store.characterConfigs === 'object') ? store.characterConfigs : {};
    store.directorApi = { ...makeDefaultDirectorApi(), ...(store.directorApi && typeof store.directorApi === 'object' ? store.directorApi : {}) };
    store.directorApi.enabled = !!store.directorApi.enabled;
    store.ui = { ...makeDefaultUi(), ...(store.ui || {}) };
    // Sổ đăng ký Worldbook trò chuyện phân tích nhân vật được tạo: Toàn cục (xuyên nhân vật/xuyên trò chuyện), key là chatId (nếu thiếu sẽ lùi về tên sách).
    // Đăng ký ở cấp độ "Worldbook trò chuyện" - Chỉ ghi lại tên sách và nhân vật sở hữu, tuyệt đối không gắn thẻ (tag) cho mục, không nhận diện dựa vào UID của mục.
    store.generatedChatBooks = (store.generatedChatBooks && typeof store.generatedChatBooks === 'object') ? store.generatedChatBooks : {};
    return store;
}

/** API đạo diễn độc lập phía người chơi (Thiết lập toàn cục, không đi theo thẻ nhân vật): Trường trống sẽ đi theo API phân tích RUBY */
export function getDirectorApiConfig() {
    const store = getSettings();
    return store ? store.directorApi : makeDefaultDirectorApi();
}

export function saveDirectorApiConfig(patch = {}) {
    const store = getSettings();
    if (!store) return;
    store.directorApi = { ...store.directorApi, ...patch };
    persist();
}

export function persist() {
    const c = ctx();
    if (typeof c?.saveSettingsDebounced === 'function') {
        c.saveSettingsDebounced();
    }
}

export function normalizeConfigData(raw) {
    const data = (raw && typeof raw === 'object') ? raw : {};
    const result = makeDefaultConfigData();
    result.charName = String(data.charName || '');
    result.customContentTags = Array.isArray(data.customContentTags)
        ? data.customContentTags.filter((t) => typeof t === 'string' && t.trim())
        : [];
    // Giao diện tóm tắt: '' = đóng; 'littlewhitebox' = Tiểu Bạch x; 'shujuku' = SP Database; 'yuzuki' = Bảng ký ức Yuzuki; 'baibaibook' = Sách bách bảo
    result.summaryProvider = ['littlewhitebox', 'shujuku', 'yuzuki', 'baibaibook'].includes(data.summaryProvider) ? data.summaryProvider : '';
    // Bảng ký ức Yuzuki: Dòng thời gian tóm tắt cốt truyện có được tiêm cùng với tóm tắt ký ức hay không (mặc định mở)
    result.yuzukiIncludePlot = data.yuzukiIncludePlot !== false;
    result.presets = Array.isArray(data.presets) && data.presets.length > 0
        ? data.presets.map(normalizePreset)
        : [makeDefaultPreset()];
    result.activePresetId = String(data.activePresetId || result.presets[0].id);
    if (!result.presets.some((p) => p.id === result.activePresetId)) {
        result.activePresetId = result.presets[0].id;
    }
    result.jailbreak = data.jailbreak || null;
    result.gen = sanitizeGenParams(data.gen);
    return result;
}

export function normalizePreset(raw) {
    const p = (raw && typeof raw === 'object') ? raw : {};
    const preset = makeDefaultPreset();
    preset.id = String(p.id || `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    preset.name = String(p.name || 'Phương án chưa đặt tên');
    preset.description = String(p.description || '');
    preset.referencePool = Array.isArray(p.referencePool)
        ? p.referencePool.map((r) => ({
            entryKey: String(r?.entryKey || ''),
            varName: String(r?.varName || ''),
            label: String(r?.label || r?.entryKey || r?.varName || ''),
        })).filter((r) => r.entryKey && r.varName)
        : [];
    preset.tasks = Array.isArray(p.tasks) ? p.tasks.map(normalizeTask) : [];
    const maxId = preset.tasks.reduce((m, t) => Math.max(m, t.id || 0), 0);
    preset.nextTaskId = Number(p.nextTaskId) > maxId ? Number(p.nextTaskId) : maxId + 1;
    const rawStartup = (p.startupTask && typeof p.startupTask === 'object') ? p.startupTask : {};
    const mergedStartup = { ...clone(DEFAULT_STARTUP), ...rawStartup };
    // Vị trí chu kỳ lấy theo trường gốc được import (cyclePositions > triggerFloors), để tránh giá trị mặc định [1,2] ghi đè dữ liệu định dạng cũ
    mergedStartup.cyclePositions = normalizePositions(
        rawStartup.cyclePositions ?? rawStartup.triggerFloors ?? mergedStartup.cyclePositions,
    );
    preset.startupTask = mergedStartup;
    const rawDirector = (p.director && typeof p.director === 'object') ? p.director : {};
    const mergedDirector = { ...clone(DEFAULT_DIRECTOR), ...rawDirector };
    mergedDirector.cycleLength = Math.max(2, Math.round(Number(rawDirector.cycleLength) || DEFAULT_DIRECTOR.cycleLength));
    mergedDirector.aggressive = !!rawDirector.aggressive;
    mergedDirector.minSpacing = Math.max(0, Math.round(Number(rawDirector.minSpacing) || 0));
    mergedDirector.retryLimit = Math.min(10, Math.max(0, Math.round(Number(rawDirector.retryLimit) ?? DEFAULT_DIRECTOR.retryLimit)));
    mergedDirector.useReferences = Array.isArray(rawDirector.useReferences) ? rawDirector.useReferences.map(String) : [];
    // Khóa (key) tuyệt đối không đưa vào thẻ: API đạo diễn là thiết lập toàn cục phía người chơi (store.directorApi), không đi theo thẻ nhân vật;
    // Các trường loại khóa (key) còn sót lại từ bản cũ (apiMode/customApi/api) loại bỏ hết
    delete mergedDirector.apiMode;
    delete mergedDirector.customApi;
    delete mergedDirector.api;
    preset.director = mergedDirector;
    return preset;
}

export function normalizeTask(raw) {
    const t = (raw && typeof raw === 'object') ? raw : {};
    const task = {
        id: Number(t.id) || 0,
        enabled: t.enabled !== false,
        displayName: String(t.displayName || `Nhiệm vụ #${t.id || '?'}`),
        cyclePositions: normalizePositions(t.cyclePositions ?? t.cyclePosition ?? t.triggerFloor),
        cyclePosition: 0,
        triggerFloor: 0,
        promptKey: String(t.promptKey || ''),
        outputKey: String(t.outputKey || ''),
        extraKeys: String(t.extraKeys || ''),
        outputVarName: String(t.outputVarName || `task_${t.id || 0}_Output`),
        enableJailbreak: t.enableJailbreak !== false,
        outputConstant: !!t.outputConstant,
        outputDisable: t.outputDisable ? 1 : 0,
        selective: !!t.selective,
        // Từ khóa lọc (keysecondary) là trường hiệu suất cao: Chỉ khi tick chọn "Sử dụng từ khóa lọc tùy chọn" và điền nội dung mới có hiệu lực,
        // Khi không tick chọn sẽ bắt buộc làm trống, tuyệt đối không dùng bất kỳ giá trị mặc định nào để lót đáy
        selectiveKeysEnabled: !!t.selectiveKeysEnabled,
        selectiveKeys: t.selectiveKeysEnabled && Array.isArray(t.selectiveKeys)
            ? t.selectiveKeys.map((k) => String(k ?? '').trim()).filter(Boolean)
            : [],
        noRecursion: !!t.noRecursion,
        position: Number.isFinite(Number(t.position)) ? Number(t.position) : 0,
        depth: Number.isFinite(Number(t.depth)) ? Number(t.depth) : 4,
        order: Number.isFinite(Number(t.order)) ? Number(t.order) : 100,
        keywordScanEnabled: !!t.keywordScanEnabled,
        keywordScanKeywords: Array.isArray(t.keywordScanKeywords)
            ? t.keywordScanKeywords.map((k) => String(k || '').trim()).filter(Boolean)
            : (typeof t.keywordScanKeywords === 'string'
                ? t.keywordScanKeywords.split(',').map((k) => k.trim()).filter(Boolean)
                : []),
        useReferences: Array.isArray(t.useReferences) ? t.useReferences.map(String) : [],
        useOutputs: Array.isArray(t.useOutputs) ? t.useOutputs.map(String) : [],
        // Trường chế độ đạo diễn: Số thứ tự ưu tiên (cùng số thì cùng cấp, số lớn hơn ưu tiên trước); Giới thiệu thủ công (Nếu để trống thì khi chạy sẽ tự động trích xuất từ mục prompt)
        directorPriority: Number.isFinite(Number(t.directorPriority)) ? Math.round(Number(t.directorPriority)) : 0,
        directorSummary: String(t.directorSummary || ''),
        // characters (Ràng buộc nhân vật cấp độ nhiệm vụ) đã bị loại bỏ: Bỏ qua trong im lặng khi đọc để tránh lọc nhầm
    };
    task.cyclePosition = task.cyclePositions[0] || 0;
    task.triggerFloor = task.cyclePosition;
    return task;
}

export function normalizePositions(raw) {
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') list = raw.split(',');
    else if (Number.isFinite(Number(raw))) list = [Number(raw)];
    return [...new Set(list.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

export function getCharacterIdentity() {
    const c = ctx();
    if (!c || c.characterId === undefined || c.characterId === null || c.characterId < 0) return null;
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    return { avatar: String(ch.avatar || ''), name: String(ch.name || '') };
}

/**
 * Cấu hình nhúng trong thẻ nhân vật: Lưu tại trường data.extensions.RubyAnalyzer của JSON thẻ nhân vật,
 * Xuất/chia sẻ cùng với thẻ. Việc đọc sẽ chạy trực tiếp trên đối tượng nhân vật hiện đang được tải.
 */
function findCharacterByIdentity(identity) {
    const c = ctx();
    if (!c || !identity?.avatar) return null;
    return (c.characters || []).find((x) => x?.avatar === identity.avatar) || null;
}

function getCardConfigRaw(identity) {
    const ch = findCharacterByIdentity(identity);
    const raw = ch?.data?.extensions?.[SETTINGS_KEY];
    return (raw && typeof raw === 'object') ? raw : null;
}

function setCardConfigInMemory(identity, value) {
    const ch = findCharacterByIdentity(identity);
    if (!ch) return false;
    ch.data ||= {};
    ch.data.extensions ||= {};
    if (value === null) delete ch.data.extensions[SETTINGS_KEY];
    else ch.data.extensions[SETTINGS_KEY] = value;
    return true;
}

function canWriteCard() {
    return typeof ctx()?.writeExtensionField === 'function';
}

let cardPersistTimer = null;
let pendingCardPersist = null;
const CARD_PERSIST_DELAY_MS = 2500;

async function flushCardPersist() {
    const job = pendingCardPersist;
    pendingCardPersist = null;
    cardPersistTimer = null;
    if (!job) return;
    const c = ctx();
    const chid = (c?.characters || []).findIndex((x) => x?.avatar === job.identity.avatar);
    if (chid < 0 || typeof c?.writeExtensionField !== 'function') {
        warn('card persist skipped: character not found or writeExtensionField unavailable');
        return;
    }
    try {
        await c.writeExtensionField(chid, SETTINGS_KEY, job.value);
        log(`card config persisted for ${job.identity.name} (${job.value === null ? 'removed' : 'updated'})`);
    } catch (e) {
        warn(`card persist failed: ${e?.message || e}`);
        window.toastr?.error?.(`RUBY: Ghi cấu hình thẻ nhân vật thất bại (${e?.message || e})`, '', { timeOut: 6000 });
    }
}

function scheduleCardPersist(identity, value) {
    pendingCardPersist = { identity, value };
    if (cardPersistTimer) return;
    cardPersistTimer = setTimeout(flushCardPersist, CARD_PERSIST_DELAY_MS);
}

/** Ghi thẻ ngay lập tức (Bỏ qua chờ debounce); Gọi sau các thao tác rõ ràng (Liên kết/Hủy liên kết/Import) */
export async function flushCardPersistNow() {
    if (cardPersistTimer) {
        clearTimeout(cardPersistTimer);
        cardPersistTimer = null;
    }
    await flushCardPersist();
}

export function resolveConfig() {
    const store = getSettings();
    if (!store) return { data: makeDefaultConfigData(), layer: 'unavailable', source: 'unavailable', identity: null };
    const identity = getCharacterIdentity();
    if (identity) {
        const cardRaw = getCardConfigRaw(identity);
        if (cardRaw) {
            return { data: normalizeConfigData(cardRaw), layer: 'character', source: 'card', identity };
        }
        if (store.characterConfigs[identity.avatar]) {
            return { data: normalizeConfigData(store.characterConfigs[identity.avatar]), layer: 'character', source: 'local', identity };
        }
    }
    return { data: store.global, layer: 'global', source: 'global', identity };
}

export function saveConfigData(data) {
    const store = getSettings();
    if (!store) return;
    const normalized = normalizeConfigData(data);
    const identity = getCharacterIdentity();
    if (identity && canWriteCard()) {
        // Mô hình lấy thẻ làm trung tâm: Khi mở nhân vật, bất kỳ thao tác lưu nào cũng mặc định ghi vào thẻ nhân vật hiện tại
        // (Lưu lần đầu là tự động liên kết, liên kết cục bộ cũ sẽ theo đó chuyển thành nhúng trong thẻ)
        setCardConfigInMemory(identity, normalized);
        scheduleCardPersist(identity, normalized);
        delete store.characterConfigs[identity.avatar];
    } else if (identity && store.characterConfigs[identity.avatar]) {
        // Phương án lùi (fallback) trong môi trường API ghi thẻ không khả dụng: Duy trì liên kết cục bộ cũ
        store.characterConfigs[identity.avatar] = normalized;
    } else {
        // Chưa mở nhân vật: Lưu tạm ở tầng toàn cục (Bảng điều khiển sẽ nhắc nhở mở thẻ nhân vật, không xuất ra cùng thẻ)
        store.global = normalized;
    }
    persist();
}

export function getActivePreset(configData) {
    const data = configData || resolveConfig().data;
    return data.presets.find((p) => p.id === data.activePresetId) || data.presets[0] || makeDefaultPreset();
}

/**
 * Liên kết cấu hình đang có hiệu lực hiện tại vào nhân vật hiện tại: Ghi vào trường data.extensions của thẻ nhân vật (xuất ra cùng thẻ).
 * Liên kết cục bộ phiên bản cũ sẽ tự động chuyển thành nhúng trong thẻ; Khi chưa liên kết thì tương đương với việc copy cấu hình toàn cục vào thẻ.
 */
export function bindToCharacter() {
    const store = getSettings();
    const identity = getCharacterIdentity();
    if (!store || !identity) return false;
    const source = resolveConfig();
    const configData = clone(source.data);
    if (canWriteCard()) {
        setCardConfigInMemory(identity, configData);
        scheduleCardPersist(identity, configData);
        delete store.characterConfigs[identity.avatar];
        flushCardPersistNow().catch(() => { /* flush nội bộ đã báo cáo lỗi */ });
        log(`config embedded into character card: ${identity.name}`);
    } else {
        store.characterConfigs[identity.avatar] = configData;
        log(`config bound to local settings (card API unavailable): ${identity.name}`);
    }
    persist();
    return true;
}

export function getBoundCharacters() {
    const store = getSettings();
    const c = ctx();
    const result = [];
    const seen = new Set();
    for (const ch of (c?.characters || [])) {
        const raw = ch?.data?.extensions?.[SETTINGS_KEY];
        if (ch?.avatar && raw && typeof raw === 'object') {
            result.push({ avatar: ch.avatar, name: ch.name || ch.avatar, source: 'card' });
            seen.add(ch.avatar);
        }
    }
    for (const avatar of Object.keys(store?.characterConfigs || {})) {
        if (seen.has(avatar)) continue;
        const ch = (c?.characters || []).find((x) => x?.avatar === avatar);
        result.push({ avatar, name: ch?.name || avatar, source: 'local' });
    }
    return result;
}

// ---------- Sổ đăng ký Worldbook trò chuyện phân tích nhân vật được tạo ----------
// Chỉ đăng ký ở cấp độ "Worldbook trò chuyện": Ghi lại tên sách + thẻ nhân vật sở hữu, không gắn thẻ (tag) cho mục, không nhận diện dựa vào UID của mục.
// Khi engine ghi đầu ra phân tích vào Worldbook trò chuyện, nó sẽ gọi registerGeneratedChatBook để gắn tag (đăng ký).

/** Lấy toàn bộ sách trò chuyện được tạo đã đăng ký (Mảng, mỗi mục mang theo key) */
export function getGeneratedChatBooks() {
    const store = getSettings();
    if (!store?.generatedChatBooks) return [];
    return Object.entries(store.generatedChatBooks).map(([key, v]) => ({
        key,
        chatId: String(v?.chatId || ''),
        chatBookName: String(v?.chatBookName || ''),
        characterAvatar: String(v?.characterAvatar || ''),
        characterName: String(v?.characterName || ''),
        createdAt: Number(v?.createdAt) || 0,
        updatedAt: Number(v?.updatedAt) || 0,
    }));
}

/** Đăng ký một quyển sách trò chuyện được tạo (gắn tag): Cùng chatId hoặc sách cùng tên sẽ cập nhật thay vì thêm mới, tính lũy đẳng (idempotent) */
export function registerGeneratedChatBook({ chatId, chatBookName, characterAvatar, characterName }) {
    const store = getSettings();
    if (!store) return;
    if (!store.generatedChatBooks || typeof store.generatedChatBooks !== 'object') store.generatedChatBooks = {};
    const map = store.generatedChatBooks;
    const name = String(chatBookName || '').trim();
    if (!name && !chatId) return;

    // Ưu tiên khớp theo chatId trước, sau đó khớp theo tên sách (để tránh đăng ký trùng lặp trong cùng một cuộc trò chuyện)
    let key = '';
    if (chatId && map[chatId]) {
        key = chatId;
    } else {
        for (const [k, v] of Object.entries(map)) {
            if (String(v?.chatBookName || '') === name) { key = k; break; }
        }
    }
    if (!key) key = String(chatId || name || `book_${Date.now()}`);

    if (map[key]) {
        const ex = map[key];
        ex.chatId = String(chatId || ex.chatId || '');
        ex.chatBookName = name || ex.chatBookName;
        ex.characterAvatar = String(characterAvatar || ex.characterAvatar || '');
        ex.characterName = String(characterName || ex.characterName || '');
        ex.updatedAt = Date.now();
    } else {
        map[key] = {
            chatId: String(chatId || ''),
            chatBookName: name,
            characterAvatar: String(characterAvatar || ''),
            characterName: String(characterName || ''),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }
    persist();
}

/** Gỡ bỏ một đăng ký (Chỉ gỡ khỏi danh sách, không xóa bản thân Worldbook) */
export function unregisterGeneratedChatBook(key) {
    const store = getSettings();
    if (!store?.generatedChatBooks || !key) return;
    if (store.generatedChatBooks[key]) {
        delete store.generatedChatBooks[key];
        persist();
    }
}

export function getApiConfig() {
    const store = getSettings();
    return store ? store.api : makeDefaultApi();
}

export function saveApiConfig(patch = {}) {
    const store = getSettings();
    if (!store) return;
    store.api = { ...store.api, ...patch };
    persist();
}

export function getUi() {
    const store = getSettings();
    return store ? store.ui : makeDefaultUi();
}

export function saveUi(patch = {}) {
    const store = getSettings();
    if (!store) return;
    store.ui = { ...store.ui, ...patch };
    persist();
}

/**
 * Phân tích template cấu hình được import, tương thích định dạng 3 thế hệ:
 * - v3 (Plugin này): Mảng presets + gen + jailbreak
 * - v2.x (Bản cũ nhiều phương án): Mảng presets + bản sao tương thích cấp cao nhất, nhiệm vụ chỉ có triggerFloor, chứa gen
 * - v1.x (Bản cũ phương án đơn): Không có presets, cấp cao nhất là tasks/referencePool/startupTask
 */
export function parseImportTemplate(raw) {
    const data = (raw && typeof raw === 'object') ? raw : null;
    if (!data) throw new Error('Dữ liệu JSON không hợp lệ');

    const metaOk = data._meta?.type === 'RUBY_ANALYZER_PRESET';
    const hasPresets = Array.isArray(data.presets) && data.presets.length > 0;
    const hasLegacy = Array.isArray(data.tasks) || Array.isArray(data.referencePool);
    if (!metaOk && !hasPresets && !hasLegacy) {
        throw new Error('Không phải là file template cấu hình RUBY hợp lệ');
    }
    if (!hasPresets && !hasLegacy) {
        throw new Error('Nội dung template trống (Không tìm thấy dữ liệu phương án)');
    }

    let presets;
    let activePresetId;
    if (hasPresets) {
        presets = data.presets.map(normalizePreset);
        activePresetId = String(data.activePresetId || '');
    } else if (hasLegacy) {
        const single = normalizePreset({
            id: String(data.activePresetId || 'default'),
            name: 'Phương án đã import',
            description: '',
            referencePool: Array.isArray(data.referencePool) ? data.referencePool : [],
            tasks: Array.isArray(data.tasks) ? data.tasks : [],
            nextTaskId: data.nextTaskId || 1,
            startupTask: (data.startupTask && typeof data.startupTask === 'object') ? data.startupTask : null,
        });
        presets = [single];
        activePresetId = single.id;
    } else {
        presets = [makeDefaultPreset()];
        activePresetId = presets[0].id;
    }
    if (!presets.some((p) => p.id === activePresetId)) {
        activePresetId = presets[0].id;
    }

    return {
        charName: String(data.charName || ''),
        customContentTags: Array.isArray(data.customContentTags)
            ? data.customContentTags.filter((t) => typeof t === 'string' && t.trim())
            : [],
        summaryProvider: ['littlewhitebox', 'shujuku', 'yuzuki', 'baibaibook'].includes(data.summaryProvider) ? data.summaryProvider : '',
        yuzukiIncludePlot: data.yuzukiIncludePlot !== false,
        jailbreak: data.jailbreak || null,
        gen: (data.gen && typeof data.gen === 'object') ? data.gen : {},
        presets,
        activePresetId,
        sourceVersion: String(data._meta?.version || 'Không rõ'),
        sourceTime: String(data._meta?.exportTime || ''),
        presetCount: presets.length,
        taskCount: presets.reduce((sum, p) => sum + (p.tasks || []).length, 0),
    };
}