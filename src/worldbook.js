import { ctx, st, q, log, warn } from './env.js';

export async function getCharBookName() {
    return String(await st('/getcharbook')).trim();
}

/**
 * Đặt tên worldbook chat: ruby-<Tên thẻ nhân vật hoặc tên worldbook chính>·Phân tích cốt truyện.
 * Cách đặt tên mặc định của /getchatbook trong ST là "Chat Book <ID chat>", quá trình dọn dẹp ASCII sẽ biến tên nhân vật thành dấu gạch dưới,
 * dẫn đến những cái tên không thể đọc được như "Chat Book _ - 2026-..."; ở đây chúng ta chủ động tạo bằng một tên có thể đọc được khi cuộc trò chuyện chưa được ràng buộc.
 * Nhiều cuộc trò chuyện của cùng một nhân vật sẽ có một cuốn sách riêng (đầu ra phân tích được ghi theo key, nếu dùng chung sẽ ghi đè lẫn nhau), nếu trùng tên thì lần lượt thử thêm hậu tố.
 */
function buildChatBookCandidates(charName) {
    const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
    const base = sanitize(`ruby-${sanitize(charName).slice(0, 40) || 'Trò chuyện'}·Phân tích cốt truyện`) || 'ruby-Phân tích cốt truyện';
    return [base, `${base} 2`, `${base} 3`, `${base} 4`, `${base} 5`, `${base} 6`];
}

export async function getChatBookName() {
    // Worldbook chat đã ràng buộc thì trả về trực tiếp (không đổi tên; cuộc trò chuyện cũ giữ nguyên tên sách gốc)
    const c = ctx();
    let charName = c?.name2 || c?.characters?.[c?.characterId]?.name || '';
    if (!charName) {
        try { charName = String(await st('/getcharbook')).trim(); } catch { /* Dự phòng tên worldbook chính thất bại, dùng tên mặc định */ }
    }
    for (const name of buildChatBookCandidates(charName)) {
        try {
            const created = String(await st(`/getchatbook create=true name=${q(name)}`)).trim();
            if (created) return created;
        } catch { /* ST ném lỗi trực tiếp với tên được chỉ định đã tồn tại: Trùng tên, thử ứng viên tiếp theo */ }
    }
    // Trường hợp cực đoan tất cả đều trùng tên: Hồi lui về cách đặt tên mặc định của ST (đảm bảo luôn lấy được sách)
    return String(await st('/getchatbook create=true')).trim();
}

async function loadBookData(bookName) {
    const c = ctx();
    if (!bookName || typeof c?.loadWorldInfo !== 'function') return null;
    try {
        return await c.loadWorldInfo(bookName);
    } catch (e) {
        warn(`loadWorldInfo failed: ${bookName} - ${e?.message || e}`);
        return null;
    }
}

function entryKeys(entry) {
    const raw = entry?.key;
    const list = Array.isArray(raw) ? raw : (raw !== undefined && raw !== null ? [raw] : []);
    const keys = [];
    for (const item of list) {
        const s = String(item ?? '').trim();
        if (!s) continue;
        keys.push(s);
        if (s.includes(',')) {
            for (const part of s.split(',')) {
                const p = part.trim();
                if (p) keys.push(p);
            }
        }
    }
    return keys;
}

/**
 * Tìm kiếm chính xác mục (entry): Trực tiếp duyệt qua dữ liệu worldbook, so sánh từng phần tử của mảng key.
 * Không thông qua lệnh gạch chéo (giá trị trả về của /getentryfield là chuỗi được serialize bằng JSON,
 * Dùng String() trực tiếp sẽ mang theo dấu ngoặc vuông dẫn đến đối chiếu thất bại), kết quả đọc nhất quán với dữ liệu UI.
 */
export async function findEntry(book, exactKey) {
    if (!book || !exactKey) return null;
    const data = await loadBookData(book);
    if (!data?.entries || typeof data.entries !== 'object') return null;
    const target = String(exactKey).trim();
    if (!target) return null;
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (entryKeys(entry).includes(target)) {
            return { uid: parseInt(uid, 10), entry, data };
        }
    }
    return null;
}

const substitute = (text) => {
    const c = ctx();
    const s = String(text ?? '');
    if (typeof c?.substituteParams !== 'function') return s;
    try {
        return String(c.substituteParams(s));
    } catch {
        return s;
    }
};

async function readEntryFrom(book, key) {
    const found = await findEntry(book, key);
    if (!found) return '';
    const content = found.entry?.content;
    if (content === undefined || content === null) return '';
    return substitute(content).trim();
}

export async function readEntry(charBook, chatBook, key, preferChat = false) {
    if (!key) return '';
    try {
        if (preferChat && chatBook) {
            const chat = await readEntryFrom(chatBook, key);
            if (chat) return chat;
        }
        const char = await readEntryFrom(charBook, key);
        if (char) return char;
        if (chatBook && !preferChat) {
            return await readEntryFrom(chatBook, key);
        }
        return '';
    } catch (e) {
        warn(`readEntry failed: ${key} - ${e.message}`);
        return '';
    }
}

export async function entryExists(book, key) {
    return (await findEntry(book, key)) !== null;
}

/** Tìm kiếm chính xác mục theo key (Giao diện công khai: truyền vào tên sách hoặc đối tượng dữ liệu), trả về { uid, entry } hoặc null */
export async function findEntryPublic(book, key) {
    return findEntry(book, key);
}

export async function disableCharEntry(charBook, entryKey) {
    if (!charBook || !entryKey) return;
    try {
        const found = await findEntry(charBook, entryKey);
        if (found) {
            await st(`/setentryfield file=${q(charBook)} uid=${found.uid} field=disable 1`);
            log(`char book entry disabled: ${entryKey}`);
        }
    } catch (e) {
        warn(`disableCharEntry failed: ${entryKey}`);
    }
}

/** Truy vấn tên worldbook đã ràng buộc với cuộc trò chuyện hiện tại; khi chưa ràng buộc thì trả về '' (không tạo sách) */
export async function getExistingChatBookName() {
    try {
        return String(await st('/getchatbook create=false')).trim();
    } catch {
        return '';
    }
}

let sanitizingFilters = false;

/**
 * Tự động dọn dẹp tàn dư lỗi lịch sử: Trước đây, writeOutputEntry ở các phiên bản cũ khi nhiệm vụ không được cấu hình từ khóa lọc,
 * sẽ ghi nhầm từ khóa phụ (keysecondary) "nsfw" vào mục đầu ra đèn xanh. Ở đây sẽ dựa theo cấu hình nhiệm vụ hiện tại
 * để tự động dọn dẹp các mục đầu ra phân tích trong worldbook chat (chỉ khớp chính xác theo outputKey của nhiệm vụ, tuyệt đối không đụng chạm
 * đến các mục khác do người sáng tạo viết tay):
 * - Nhiệm vụ có đánh dấu "Sử dụng từ khóa lọc tùy chọn" và có điền nội dung → Từ khóa phụ dựa theo cấu hình;
 * - Không đánh dấu → Xóa sạch từ khóa phụ (đèn xanh chỉ kích hoạt theo từ khóa chính);
 * - Nhiệm vụ không phải đèn xanh → Tiện thể đặt lại selective=0 và xóa sạch từ khóa phụ.
 * Trả về số lượng mục đã dọn dẹp (0 = Không cần dọn dẹp hoặc chưa ràng buộc worldbook chat).
 */
export async function sanitizeOutputFilters(chatBook, tasks) {
    if (sanitizingFilters) return 0;
    if (!chatBook || !Array.isArray(tasks) || tasks.length === 0) return 0;
    sanitizingFilters = true;
    try {
        const data = await loadBookData(chatBook);
        if (!data?.entries || typeof data.entries !== 'object') return 0;

        const fixes = [];
        for (const task of tasks) {
            const outputKey = String(task?.outputKey || '').trim();
            if (!outputKey) continue;
            const found = Object.entries(data.entries).find(([, entry]) => entryKeys(entry).includes(outputKey));
            if (!found) continue;
            const uid = parseInt(found[0], 10);
            if (isNaN(uid)) continue;
            const entry = found[1];
            const wantSelective = !!task?.selective;
            const wantKeys = wantSelective && task?.selectiveKeysEnabled && Array.isArray(task?.selectiveKeys)
                ? task.selectiveKeys.map((k) => String(k ?? '').trim()).filter(Boolean)
                : [];
            const currentKeys = Array.isArray(entry?.keysecondary)
                ? entry.keysecondary.map((k) => String(k ?? '').trim()).filter(Boolean)
                : [];
            const keysDiffer = currentKeys.join('\u0001') !== wantKeys.join('\u0001');
            const selectiveDiffers = !!entry?.selective !== wantSelective;
            if (!keysDiffer && !selectiveDiffers) continue;
            fixes.push({ uid, outputKey, keysDiffer, selectiveDiffers, wantKeys, wantSelective, currentKeys });
        }
        if (fixes.length === 0) return 0;

        for (const fix of fixes) {
            if (fix.keysDiffer) {
                if (fix.wantKeys.length > 0) {
                    const selVar = `_ruby_sel_${Date.now()}_${fix.uid}`;
                    await st(`/setvar key=${selVar} ${q(fix.wantKeys.join(', '))}`);
                    await st(`/getvar ${selVar} | /setentryfield file=${q(chatBook)} uid=${fix.uid} field=keysecondary`);
                } else {
                    await st(`/setentryfield file=${q(chatBook)} uid=${fix.uid} field=keysecondary ""`);
                }
            }
            if (fix.selectiveDiffers) {
                await st(`/setentryfield file=${q(chatBook)} uid=${fix.uid} field=selective ${fix.wantSelective ? 1 : 0}`);
            }
            log(`output filter sanitized: ${fix.outputKey} (uid ${fix.uid}) keysecondary [${fix.currentKeys.join(', ')}] -> [${fix.wantKeys.join(', ')}]`);
        }
        await persistBook(chatBook);
        return fixes.length;
    } finally {
        sanitizingFilters = false;
    }
}

export async function writeOutputEntry(chatBook, options) {
    const {
        key, extraKeys = '', content, comment = '', constant = false, disable = false,
        noRecursion = false, position = 0, depth = 4, order = 100,
        selective = false, selectiveKeys = [],
    } = options;
    if (!chatBook || !key) throw new Error('chat book or output key missing');

    let uid;
    const found = await findEntry(chatBook, key);
    if (found) {
        uid = found.uid;
        log(`output entry found, updating: ${key} (uid ${uid})`);
    } else {
        const uidRaw = await st(`/createentry file=${q(chatBook)} key=${q(key)} ""`);
        uid = parseInt(uidRaw, 10);
        if (isNaN(uid)) throw new Error(`create entry failed: ${key}`);
        log(`output entry created: ${key}`);
    }

    if (comment) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=comment ${q(String(comment).trim())}`);
    }

    const extraKeysList = String(extraKeys || '').split(',').map((k) => k.trim()).filter(Boolean);
    const allKeys = [key, ...extraKeysList].join(', ');

    if (extraKeysList.length > 0) {
        const varName = `_ruby_key_${Date.now()}`;
        await st(`/setvar key=${varName} ${q(allKeys)}`);
        await st(`/getvar ${varName} | /setentryfield file=${q(chatBook)} uid=${uid} field=key`);
    }

    const contentVar = `_ruby_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await st(`/setvar key=${contentVar} ${q(String(content || '').trim())}`);
    await st(`/getvar ${contentVar} | /setentryfield file=${q(chatBook)} uid=${uid} field=content`);

    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=constant ${constant ? 1 : 0}`);
    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=disable ${disable ? 1 : 0}`);

    if (noRecursion) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=excludeRecursion 1`);
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=preventRecursion 1`);
    }

    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=position ${position}`);
    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=order ${order}`);

    if (position === 4) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=depth ${depth}`);
    }

    // Từ khóa phụ (Từ khóa lọc) là trường có hiệu lực cao, nghiêm cấm mọi giá trị mặc định làm dự phòng:
    // Chỉ ghi vào khi bên gọi truyền vào selectiveKeys không rỗng một cách rõ ràng, nếu không thì xóa sạch;
    // Các mục không phải đèn xanh sẽ luôn được đặt lại selective=0 và xóa sạch từ khóa phụ, để ngăn trạng thái cũ còn sót lại.
    const filterKeys = (Array.isArray(selectiveKeys) ? selectiveKeys : [])
        .map((k) => String(k ?? '').trim()).filter(Boolean);
    if (filterKeys.length > 0) {
        const selVar = `_ruby_sel_${Date.now()}`;
        await st(`/setvar key=${selVar} ${q(filterKeys.join(', '))}`);
        await st(`/getvar ${selVar} | /setentryfield file=${q(chatBook)} uid=${uid} field=keysecondary`);
    } else {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=keysecondary ""`);
    }
    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=selective ${selective ? 1 : 0}`);
    if (selective) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=selectiveLogic 0`);
    }
    log(`output written: ${key}${extraKeysList.length ? ` (keys: ${allKeys})` : ''}`);
}

export async function persistBook(bookName) {
    const c = ctx();
    if (!bookName || typeof c?.loadWorldInfo !== 'function' || typeof c?.saveWorldInfo !== 'function') {
        if (typeof c?.saveChat === 'function') {
            try { await c.saveChat(); } catch (e) { warn(`saveChat fallback failed: ${e.message}`); }
        }
        return;
    }
    try {
        const worldData = await c.loadWorldInfo(bookName);
        await c.saveWorldInfo(bookName, worldData, true);
        log(`world book persisted: ${bookName}`);
    } catch (e) {
        warn(`saveWorldInfo failed: ${e.message}`);
        if (typeof c?.saveChat === 'function') {
            try { await c.saveChat(); } catch (e2) { warn(`saveChat fallback failed: ${e2.message}`); }
        }
    }
}

export function extractEntryKeywords(entry) {
    const out = [];
    const pushKeywords = (v) => {
        if (!v) return;
        if (Array.isArray(v)) {
            v.forEach(pushKeywords);
            return;
        }
        const s = String(v).trim();
        if (!s) return;
        s.split(',').map((x) => x.trim()).filter(Boolean).forEach((k) => out.push(k));
    };
    pushKeywords(entry?.key);
    pushKeywords(entry?.keys);
    return [...new Set(out)];
}

export async function scanBookKeys(bookName) {
    const c = ctx();
    if (!bookName || typeof c?.loadWorldInfo !== 'function') throw new Error('world info API unavailable');
    const worldData = await c.loadWorldInfo(bookName);
    const entries = Object.values(worldData?.entries || {});
    const allKeys = [];
    for (const entry of entries) {
        for (const key of extractEntryKeywords(entry)) {
            allKeys.push(key);
        }
    }
    return [...new Set(allKeys)].sort((a, b) => a.localeCompare(b, 'vi-VN'));
}