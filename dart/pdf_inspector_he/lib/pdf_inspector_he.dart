/// Hebrew / RTL invoices from PDF on the device (dart:ffi over the Rust
/// library `pdf_inspector_he`).
///
/// ```dart
/// final engine = PdfInspectorHe.open();
/// final read = engine.readInvoice(bytes);
/// switch (read.document.status) {
///   case InvoiceStatus.ok: ...                       // every check closes
///   case InvoiceStatus.repairable:                    // a few rows do not:
///     final answer = await askModel(read.document.repair!); // prompt + schema
///     final fixed = engine.applyRepair(read.state!, answer);
///   case InvoiceStatus.unreadable: ...                // send the pages instead
/// }
/// ```
library;

export 'src/engine.dart';
export 'src/library.dart' show libraryFileName, PdfInspectorHeLibraryException;
export 'src/model.dart';
