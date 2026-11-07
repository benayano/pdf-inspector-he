# pdf-inspector-he

פורק של [firecrawl/pdf-inspector](https://github.com/firecrawl/pdf-inspector) (רישיון MIT) עם תמיכה טובה יותר בעברית, בעיקר בשורות טבלה של חשבוניות.

## מה תוקן

שתי תקלות בשורות מימין לשמאל, כשכל אות מצוירת בנפרד (כך מדפיס למשל "Microsoft: Print To PDF"):

1. **מילים נדבקות.** הסף שקובע מה נחשב רווח בין מילים חושב מכל הפערים בשורה, כולל הפערים הגדולים בין עמודות הטבלה. לכן הוא יצא גבוה מרווח רגיל, וכל השורה נדבקה: `מסילהלפאנל10מגולוון`. עכשיו פערים מעל em אחד לא נכנסים לחישוב, והסף יורד עד שמגיע להפרדה בין אותיות לרווחים.
2. **מספרים מתהפכים.** שני מספרים שמופרדים ברווח רגיל (`1.2 3`) נקראו כמספר אחד (`31.2`), כי הסף למספרים היה 0.3 em, ורווח רגיל הוא כ-0.28 em. ברירת המחדל עכשיו 0.2.

**תוצאה על חשבונית בדיקה (162 שורות):** לפני התיקון 133 תיאורים זהים לצינור הקיים (pdfplumber + bidi), אחריו 160. בשתי השורות הנותרות דווקא pdfplumber טועה והכלי צודק. כלומר 162 מתוך 162 נכונות.

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
- **חבילת הרגרסיה של Firecrawl** (`pdf-evals`, כ-200 PDFs) לא נגישה. יכול להיות שהשינוי בסף המילים משפיע על מסמכים אחרים. כל הבדיקות שבריפו עוברות (כ-1,950).

## בנייה ובדיקות

```bash
cargo test --release
cargo build --release --bin pdf2md
node --test he/*.test.mjs
```
