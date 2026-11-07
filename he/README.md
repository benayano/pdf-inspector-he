# pdf-inspector-he

פורק של [firecrawl/pdf-inspector](https://github.com/firecrawl/pdf-inspector) (רישיון MIT) עם תמיכה טובה יותר בעברית, בעיקר בשורות טבלה של חשבוניות.

## מה תוקן

שתי תקלות בשורות מימין לשמאל, כשכל אות מצוירת בנפרד (כך מדפיס למשל "Microsoft: Print To PDF"):

1. **מילים נדבקות.** הסף שקובע מה נחשב רווח בין מילים חושב מכל הפערים בשורה, כולל הפערים הגדולים בין עמודות הטבלה. לכן הוא יצא גבוה מרווח רגיל, וכל השורה נדבקה: `מסילהלפאנל10מגולוון`. עכשיו פערים מעל em אחד לא נכנסים לחישוב, והסף יורד עד שמגיע להפרדה בין אותיות לרווחים.
2. **מספרים מתהפכים.** שני מספרים שמופרדים ברווח רגיל (`1.2 3`) נקראו כמספר אחד (`31.2`), כי הסף למספרים היה 0.3 em, ורווח רגיל הוא כ-0.28 em. ברירת המחדל עכשיו 0.2.

**תוצאה על חשבונית בדיקה (162 שורות):** לפני התיקון 133 תיאורים זהים לצינור הקיים (pdfplumber + bidi), אחריו 160. בשתי השורות הנותרות דווקא pdfplumber טועה והכלי צודק. כלומר 162 מתוך 162 נכונות.

## טבלאות

ארבע תקלות מנעו זיהוי של טבלת הפריטים בחשבונית. אחרי התיקון כל 162 השורות יוצאות כטבלת Markdown עם 9 עמודות, בסדר קריאה מימין לשמאל, ותיבת הסיכומים יוצאת כטבלה נפרדת.

1. **הטבלה סווגה כתוכן עניינים.** בסדר המסך (שמאל לימין) העמודה הראשונה היא סכום ("66.10", נראה כמו מספר סעיף) והאחרונה היא מספר השורה (1, 2, 3, נראה כמו מספרי עמודים). עכשיו טבלה מימין לשמאל נבדקת בסדר הקריאה שלה, ונכתבת ל-Markdown מהעמודה הימנית.
2. **קווי הטבלה לא זוהו.** דפדפנים ו-"Print To PDF" מציירים גבולות תאים כצורות מלאות דקות (ולא כקווים), וכל תא מצייר את הגבולות שלו בנפרד. עכשיו רצועה דקה מלאה נקראת כקו, קטעי קו אנכיים שנוגעים זה בזה מתחברים, וגם מסגרת סגורה שמצוירת בקו (`m l l l h S`) נקראת. בקוד המקורי היא נבלעה.
3. **כותרת בשתי שורות.** תא כותרת בשתי שורות ("מחיר ליח'" מעל "אחרי הנחה") ליד תאים בשורה אחת נקרא כשורה אחת עם אותיות משולבות. עכשיו שורות מוערמות מופרדות.
4. **תאים מעורבים.** תא כמו `אומגה 2" BANIT` (כמות שווה של אותיות עבריות ולטיניות) מסודר לפי כיוון הטבלה, וקטע לטיני נשאר שלם.

## פרמטרים לכוונון (knobs)

הספים של התיקונים אינם נעולים: לכל אחד יש ערך `auto` (ברירת המחדל, יחסית למסמך איפה שאפשר) ואפשר לקבוע ערך ידנית.

| knob | יחידה | auto | מה הוא משנה |
|---|---|---|---|
| `number_gap` | em | 0.2 | מאיזה רווח שני מספרים צמודים הם שני מספרים |
| `word_gap_cap` | em | 1.0 | פערים גדולים מזה (בין עמודות) לא נכנסים לחישוב הרווח בין מילים |
| `rule_thickness` | pt | 3.0 | רצועה מלאה דקה מזה נקראת כקו טבלה (0 מכבה) |
| `rule_join_gap` | pt | 2.0 | קטעי קו אנכי במרחק כזה מתחברים |
| `short_rule_ratio` | חלק מהקו הארוך | 0.3 | קווים קצרים מזה שייכים לתיבה אחרת (סיכומים) |
| `stacked_line_gap` | em | 0.5 | מאיזה מרחק שורות מוערמות מופרדות |

הצורה בכל מקום: `"rule_join_gap=3,short_rule_ratio=auto"`.

| איפה | איך |
|---|---|
| משתנה סביבה | `PDF_INSPECTOR_TUNING="rule_join_gap=3"` |
| CLI | `pdf2md --tune rule_join_gap=3 file.pdf`, `pdf2md --list-knobs` |
| Python | `process_pdf(path, tuning="...")`, `set_tuning("...")`, `list_knobs()` |
| Node | `setTuning("...")`, `listKnobs()` |
| WebAssembly | `processPdf(data, { tuning: "..." })`, `extractTextWithPositions(data, { tuning })`, `listKnobs()` |
| Rust | `with_tuning(Tuning::parse("...")?, \|\| ...)`, `set_process_tuning(...)` |

**כוונון עם LLM** (`he/rtl-check.mjs`):
- `chooseTuning(run, data, ask, { candidates: ["", "rule_join_gap=4", ...] })` מריץ את המסמך עם כל הגדרה, שולח ל-LLM רק את השורות שבהן התוצאות שונות, ומחזיר את ההגדרה שנבחרה.
- `extractionToolDefinition(listKnobs())` מחזיר הגדרת tool (בפורמט של Anthropic) עם תיאור כל ה-knobs, כך ש-agent יכול לקרוא לחילוץ בעצמו, לראות שהתוצאה שגויה ולנסות ערכים אחרים.

## הפרמטר `number_gap`

הסף למספרים ניתן לשינוי בלי לשנות קוד. ערך: מספר ב-em, או `auto`, שלוקח את הסף מהרווחים של השורה עצמה.

| איפה | איך |
|---|---|
| משתנה סביבה (כל השפות) | `PDF_INSPECTOR_NUMBER_GAP_EM=auto` או `0.25` |
| CLI | `pdf2md --number-gap auto file.pdf` |
| Python | `extract_text_with_positions(path, number_gap="auto")`, או `set_number_gap(0.25)` לכל התהליך |
| Node (napi) | `setNumberGap('auto')` |
| WebAssembly (דפדפן / Deno / Supabase) | `extractTextWithPositions(data, { numberGap: 'auto' })`, `processPdf(data, { numberGap: 0.25 })` |
| Rust | `with_number_gap(NumberGap::Auto, \|\| ...)`, `set_process_number_gap(...)` |

סדר העדיפות: ערך שניתן בקריאה עצמה, אחריו ערך לכל התהליך, אחריו משתנה הסביבה, ולבסוף 0.2.

## בדיקה חלקית עם AI והחלה על כל המסמך

`he/rtl-check.mjs` (JavaScript, בלי תלויות):

1. מחלץ את המסמך בכמה ערכים (0.1, 0.2, 0.3).
2. משאיר רק את השורות שבהן התוצאה שונה. בחשבונית הבדיקה: 27 מתוך 290.
3. שולח מדגם מהן ל-LLM, שבוחר את הקריאה הנכונה. ה-LLM רואה רק את הקריאות, בלי הערכים, ומתבקש לבדוק חשבון בין העמודות (3.2 × 19 = 60.80).
4. בוחר את הערך שמתאים לרוב התשובות, ומחלץ מחדש את כל המסמך עם הערך הזה.

הספרייה לא קוראת ל-AI בעצמה ולא מחזיקה מפתח. את הפונקציה `ask(prompt)` אתה מעביר, למשל קריאה ל-Claude מתוך Edge Function עם מפתח מהסודות של Supabase. אם ה-LLM לא בטוח, או שאין הסכמה, נשארים עם ברירת המחדל.

```js
import * as pdf from "./pdf-inspector/pdf_inspector.js";
import { extractWithLlmCheck } from "./pdf-inspector/rtl-check.mjs";

const result = await extractWithLlmCheck(
  (data, o) => pdf.extractTextWithPositions(data, o),
  pdfBytes,
  askClaude, // async (prompt) => text
  { context: "Hebrew supplier invoice", sample: 12 },
);
// result.numberGap, result.rows, result.check
```

דוגמה מלאה ל-Supabase Edge Function: `he/supabase-example/index.ts`.

## חבילות npm / Supabase

ה-workflow `he build` (`.github/workflows/he-build.yml`) בונה בכל push:

- `pdf-inspector-he-wasm-web`: לדפדפן (React).
- `pdf-inspector-he-wasm-deno`: ל-Deno ול-Supabase Edge Functions. בדיקת עשן רצה עליה ב-Deno.

שתיהן כוללות את `rtl-check.mjs`. אפשר להוריד אותן מה-Artifacts של הריצה. tag בצורה `he-v1.0.0` יוצר Release עם קבצי zip.

## מה לא נבדק

- **ה-wasm לא נבנה מקומית.** בסביבה שבה זה נכתב אין יעד `wasm32`. הבנייה הראשונה והבדיקה ב-Deno יקרו ב-GitHub Actions.
- **קריאה ל-Claude לא נבדקה.** לא היה מפתח בסביבה. הלוגיקה סביבה נבדקה עם תשובות מדומות (`he/rtl-check.test.mjs`).
- **הרצה בתוך Supabase לא נבדקה בפועל.**
- **חבילת הרגרסיה של Firecrawl** (`pdf-evals`, כ-200 PDFs) לא נגישה. יכול להיות שהשינויים (סף המילים, קריאת רצועות מלאות כקווים, חיבור קטעי קו, הפרדת שורות מוערמות) משפיעים על מסמכים אחרים. כל הבדיקות שבריפו עוברות (כ-1,960), כולל צילומי הפלט של כל קבצי הבדיקה. אם משהו נשבר במסמך אחר, הכיוון הראשון הוא ה-knobs.

## בנייה ובדיקות

```bash
cargo test --release
cargo build --release --bin pdf2md
node --test he/*.test.mjs
```
