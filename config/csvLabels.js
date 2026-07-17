/**
 * BILINGUAL CSV EXPORT LABELS (uz/ru)
 *
 * Mirrors the frontend's bilingual pattern (ezone/src/context/LanguageContext.jsx,
 * ezone/src/config/errorCodes.js) on the backend, since CSV files are generated
 * server-side as a raw byte stream — there's no JSON response the frontend could
 * run through LanguageContext.t() after the fact. The language itself comes from
 * the client's current LanguageContext value, forwarded automatically on every
 * request via the X-Language header (see ezone/src/api/client.js's request
 * interceptor) — no export call site hardcodes a language.
 *
 * Enum value dictionaries (categories/inventoryStatuses/syncStatuses/
 * transactionTypes) use the exact same translated strings as their frontend
 * counterparts (statusBadge.js, LanguageContext.jsx) so a status reads
 * identically whether seen in the UI or in an exported file.
 */

const SUPPORTED_LANGUAGES = ['uz', 'ru'];

const LABELS = {
  uz: {
    columns: {
      id: 'ID', barcode: 'Shtrix-kod', brand: 'Brend', model: 'Model', category: 'Toifa',
      status: 'Holat', branch: 'Filial', importBatchId: 'Import partiyasi ID',
      createdAt: 'Yaratilgan sana', updatedAt: 'Yangilangan sana',
      employee: 'Xodim', ownerName: 'Egasi ismi', ownerPhone: 'Egasi telefoni', vehicle: 'Avtomobil',
      plateNumber: 'Davlat raqami', vin: 'VIN', fuelType: "Yoqilg'i turi", installationDate: "O'rnatish sanasi",
      easygasSyncStatus: 'EasyGas holati', easygasWarrantyNumber: 'EasyGas kafolat raqami',
      installer: "O'rnatuvchi", points: 'Ball', type: 'Tur', product: 'Mahsulot', reason: 'Sabab',
      metric: "Ko'rsatkich", value: 'Qiymat',
      totalWarranties: 'Jami kafolatlar', successfulInstalls: "Muvaffaqiyatli o'rnatishlar",
      rejectedInstalls: 'Rad etilgan o\'rnatishlar', lifetimePoints: 'Umrbod ballar',
      imported: 'Import qilindi', installed: "O'rnatildi", remainingStock: 'Qolgan zaxira',
      failureRate: 'Nosozlik darajasi %', returnRate: 'Qaytarish darajasi %',
      warehouse: 'Ombor', total: 'Jami', currentStock: 'Joriy zaxira', installedStock: "O'rnatilgan zaxira",
      reservedStock: 'Band qilingan zaxira', damagedStock: 'Shikastlangan zaxira',
      returnedStock: 'Qaytarilgan zaxira', lostStock: "Yo'qolgan zaxira",
    },
    unassigned: 'Tayinlanmagan',
    notAvailable: 'Mavjud emas',
    categories: {
      REDUCER: 'Redyuktor', CYLINDER: 'Tsilindr', CONTROLLER: 'STAG Kontrolyeri', ECU: 'ECU (boshqaruv bloki)',
      INJECTOR_RAIL: 'Injektor relsi', FILLING_VALVE: "To'ldirish klapani", MULTIVALVE: 'Multiklapan',
      PRESSURE_SENSOR: 'Bosim sensori', FILTER: 'Filtr', OTHER: 'Boshqa',
    },
    inventoryStatuses: {
      IN_STOCK: 'Mavjud', RESERVED: 'Band qilingan', INSTALLED: "O'rnatilgan", RETURNED: 'Qaytarilgan',
      DAMAGED: 'Shikastlangan', LOST: "Yo'qolgan", MERGED: 'Birlashtirilgan',
    },
    fuelTypes: { LPG: 'LPG', CNG: 'CNG' },
    syncStatuses: { PENDING: 'Navbatda', SYNCING: 'Yuborilmoqda', SYNCED: 'Sinxronlangan', FAILED: 'Muvaffaqiyatsiz' },
    transactionTypes: {
      WARRANTY_AWARD: 'Kafolat uchun ball', WARRANTY_REVERSAL: 'Ball qaytarildi',
      MANUAL_ADJUSTMENT: "Qo'lda tuzatish", MANUAL_BONUS: 'Bonus', MANUAL_PENALTY: 'Jarima',
    },
    metrics: {
      totalProducts: 'Jami mahsulotlar', totalInventory: 'Jami zaxira', installedProducts: "O'rnatilgan mahsulotlar",
      availableInventory: 'Mavjud zaxira', damagedInventory: 'Shikastlangan zaxira', lostInventory: "Yo'qolgan zaxira",
      returnedInventory: 'Qaytarilgan zaxira', importedToday: 'Bugun import qilindi',
      importedThisMonth: 'Shu oy import qilindi', warrantyCount: 'Kafolatlar soni',
      warrantySuccessRate: 'Kafolat muvaffaqiyat foizi',
    },
    locale: 'uz-UZ',
  },
  ru: {
    columns: {
      id: 'ID', barcode: 'Штрих-код', brand: 'Бренд', model: 'Модель', category: 'Категория',
      status: 'Статус', branch: 'Филиал', importBatchId: 'ID партии импорта',
      createdAt: 'Дата создания', updatedAt: 'Дата обновления',
      employee: 'Сотрудник', ownerName: 'Имя владельца', ownerPhone: 'Телефон владельца', vehicle: 'Автомобиль',
      plateNumber: 'Гос. номер', vin: 'VIN', fuelType: 'Тип топлива', installationDate: 'Дата установки',
      easygasSyncStatus: 'Статус EasyGas', easygasWarrantyNumber: 'Номер гарантии EasyGas',
      installer: 'Установщик', points: 'Баллы', type: 'Тип', product: 'Продукт', reason: 'Причина',
      metric: 'Показатель', value: 'Значение',
      totalWarranties: 'Всего гарантий', successfulInstalls: 'Успешные установки',
      rejectedInstalls: 'Отклонённые установки', lifetimePoints: 'Баллы за всё время',
      imported: 'Импортировано', installed: 'Установлено', remainingStock: 'Остаток на складе',
      failureRate: 'Процент отказов %', returnRate: 'Процент возвратов %',
      warehouse: 'Склад', total: 'Всего', currentStock: 'Текущий запас', installedStock: 'Установленный запас',
      reservedStock: 'Зарезервированный запас', damagedStock: 'Повреждённый запас',
      returnedStock: 'Возвращённый запас', lostStock: 'Утерянный запас',
    },
    unassigned: 'Не назначен',
    notAvailable: 'Нет данных',
    categories: {
      REDUCER: 'Редуктор', CYLINDER: 'Цилиндр', CONTROLLER: 'Контроллер STAG', ECU: 'ЭБУ (блок управления)',
      INJECTOR_RAIL: 'Инжекторная рейка', FILLING_VALVE: 'Заправочный клапан', MULTIVALVE: 'Мультиклапан',
      PRESSURE_SENSOR: 'Датчик давления', FILTER: 'Фильтр', OTHER: 'Другое',
    },
    inventoryStatuses: {
      IN_STOCK: 'В наличии', RESERVED: 'Зарезервирован', INSTALLED: 'Установлен', RETURNED: 'Возвращён',
      DAMAGED: 'Повреждён', LOST: 'Утерян', MERGED: 'Объединён',
    },
    fuelTypes: { LPG: 'LPG', CNG: 'CNG' },
    syncStatuses: { PENDING: 'В очереди', SYNCING: 'Отправляется', SYNCED: 'Синхронизировано', FAILED: 'Ошибка' },
    transactionTypes: {
      WARRANTY_AWARD: 'Баллы за гарантию', WARRANTY_REVERSAL: 'Баллы возвращены',
      MANUAL_ADJUSTMENT: 'Ручная корректировка', MANUAL_BONUS: 'Бонус', MANUAL_PENALTY: 'Штраф',
    },
    metrics: {
      totalProducts: 'Всего продуктов', totalInventory: 'Всего запасов', installedProducts: 'Установленные продукты',
      availableInventory: 'Доступные запасы', damagedInventory: 'Повреждённые запасы', lostInventory: 'Утерянные запасы',
      returnedInventory: 'Возвращённые запасы', importedToday: 'Импортировано сегодня',
      importedThisMonth: 'Импортировано в этом месяце', warrantyCount: 'Количество гарантий',
      warrantySuccessRate: 'Процент успешных гарантий',
    },
    locale: 'ru-RU',
  },
};

/** Reads X-Language (set automatically by the frontend's axios interceptor
 * from LanguageContext) and falls back to 'uz' for anything else — same
 * default LanguageContext.jsx itself uses when nothing is stored yet. */
const resolveLanguage = (req) => {
  const requested = req.get('X-Language');
  return SUPPORTED_LANGUAGES.includes(requested) ? requested : 'uz';
};

const getLabels = (language) => LABELS[SUPPORTED_LANGUAGES.includes(language) ? language : 'uz'];

/** Falls back to the raw value itself (never blank) if it's an enum value
 * this dictionary doesn't know about yet — matches the frontend's own
 * `translations[language][key] || key` fallback convention. */
const translateEnum = (dict, value) => {
  if (value === null || value === undefined) return '';
  return dict[value] || value;
};

/** `value` is whatever mysql2 returned for a DATE/DATETIME/TIMESTAMP column —
 * a JS Date for DATETIME/TIMESTAMP, or a 'YYYY-MM-DD' string for DATE
 * columns (mysql2's default, dateStrings not enabled). Both parse correctly
 * via `new Date(...)`. `includeTime` distinguishes a pure calendar date
 * (Installation Date) from a real timestamp (Created At/Updated At). */
const formatCsvDate = (value, language, includeTime = false) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date)) return '';
  const locale = getLabels(language).locale;
  return includeTime
    ? date.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
};

module.exports = { resolveLanguage, getLabels, translateEnum, formatCsvDate };
