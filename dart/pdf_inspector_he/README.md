# pdf_inspector_he (Dart)

Hebrew / RTL invoices read **on the device** through `dart:ffi`: the item
table, header, totals, arithmetic checks and — when a few rows do not close —
a compact repair request for a model. The same Rust code as `pdf2md
--invoice-json`, the wasm package and the Edge package (`src/invoice/`).

```dart
final engine = PdfInspectorHe.open();               // libpdf_inspector_he.so
final read = await engine.readInvoiceAsync(bytes);  // isolate: keeps the UI smooth
final doc = read.document;                          // invoice-document@1
if (doc.status == InvoiceStatus.repairable) {
  // doc.repair!.prompt (the failing rows as CSV) + doc.repair!.schema → a model
  final fixed = engine.applyRepair(read.state!, answerJson);
}
```

Nothing here calls a model or the network.

## The native library

One C ABI (`ffi/include/pdf_inspector_he.h`): `pdfhe_call(method, request_json,
bytes, len)` → JSON, `pdfhe_free`, `pdfhe_abi_version`. Methods:
`src/invoice/api.rs`.

| target | build | where it goes |
|---|---|---|
| host (tests) | `cd ffi && cargo build --release` | `PDF_INSPECTOR_HE_LIB=…/libpdf_inspector_he.so` |
| Android | `cd ffi && cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o <app>/android/app/src/main/jniLibs build --release` | jniLibs (the APK) |
| iOS | `staticlib` (`libpdf_inspector_he.a`), linked into Runner | `DynamicLibrary.process()` |

CI (`.github/workflows/he-build.yml`) builds the Android libraries and runs
the tests below against the host build.

## Tests

```bash
(cd ../../ffi && cargo build --release)
dart pub get && dart analyze && dart test
```
