import 'dart:convert';
import 'dart:ffi';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'library.dart';
import 'model.dart';

/// Options for [PdfInspectorHe.readInvoice].
class ReadOptions {
  const ReadOptions({
    this.tuning = '',
    this.alternatives,
    this.pages,
    this.markdown = false,
    this.repairRequest = true,
    this.context = '',
    this.maxPages,
    this.firstPage = false,
  });

  /// Layout knobs, `knob=value,...` ([PdfInspectorHe.listKnobs]).
  final String tuning;

  /// Other readings tried on the pages of failing rows, with no model
  /// (default: number_gap 0.1, 0.3, auto). Empty list: none.
  final List<String>? alternatives;

  /// 1-based pages to read; null for the whole document.
  final List<int>? pages;

  /// Include the extracted Markdown in the document.
  final bool markdown;

  /// Include the repair request of a repairable invoice.
  final bool repairRequest;

  /// One line for the model about the document (supplier, its quirks).
  final String context;

  /// A document with more pages (of those selected) is not read: the answer
  /// is `unreadable` within a millisecond or two.
  final int? maxPages;

  /// Also return page 1's Markdown ([InvoiceRead.firstPage]) from the same
  /// extraction, e.g. to find the supplier's tax id on the page.
  final bool firstPage;

  Map<String, Object?> toJson() => {
        'tuning': tuning,
        if (alternatives != null) 'alternatives': alternatives,
        if (pages != null) 'pages': pages,
        'markdown': markdown,
        'repair_request': repairRequest,
        'context': context,
        if (maxPages != null) 'max_pages': maxPages,
        if (firstPage) 'first_page': true,
      };
}

/// The invoice reader on this device. Calls are synchronous and CPU-bound
/// (a page takes milliseconds, a long invoice up to a second or two): from
/// a UI isolate use the `...Async` methods, which run in a fresh isolate.
class PdfInspectorHe {
  PdfInspectorHe._(this._bindings, this._path);

  /// [path] overrides where the native library is loaded from
  /// (default: `PDF_INSPECTOR_HE_LIB`, else the platform's lookup).
  factory PdfInspectorHe.open({String? path}) {
    final bindings = Bindings(openLibrary(path));
    final abi = bindings.abiVersion();
    if (abi != supportedAbiVersion) {
      throw PdfInspectorHeLibraryException(
          'native library ABI $abi, this package expects $supportedAbiVersion');
    }
    return PdfInspectorHe._(bindings, path);
  }

  final Bindings _bindings;
  final String? _path;

  /// One raw call (methods: ffi/src/lib.rs, src/invoice/api.rs). Returns
  /// `result`; throws [InvoiceReaderException] on `{"ok": false}`.
  Map<String, dynamic> call(String method, [Map<String, Object?> request = const {}, Uint8List? bytes]) {
    final m = method.toNativeUtf8();
    final r = jsonEncode(request).toNativeUtf8();
    final length = bytes?.length ?? 0;
    final data = length == 0 ? nullptr : malloc<Uint8>(length);
    Pointer<Char> out = nullptr;
    try {
      if (length > 0) data.asTypedList(length).setAll(0, bytes!);
      out = _bindings.call(m.cast(), r.cast(), data, length);
      final reply = jsonDecode(out.cast<Utf8>().toDartString()) as Map<String, dynamic>;
      if (reply['ok'] != true) {
        throw InvoiceReaderException(method, '${reply['error'] ?? 'unknown error'}');
      }
      return (reply['result'] as Map?)?.cast<String, dynamic>() ?? const {};
    } finally {
      if (out != nullptr) _bindings.free(out);
      malloc.free(m);
      malloc.free(r);
      if (data != nullptr) malloc.free(data);
    }
  }

  /// Extract, parse, check, and try other readings for failing rows: the
  /// whole read in ONE native call (the PDF is classified first, so a scan or
  /// a document over [ReadOptions.maxPages] costs a millisecond or two).
  InvoiceRead readInvoice(Uint8List pdf, [ReadOptions options = const ReadOptions()]) {
    final out = call('read_invoice', options.toJson(), pdf);
    final state = out['state'];
    return InvoiceRead(
      InvoiceDocument((out['document'] as Map).cast()),
      state is Map ? InvoiceState(state.cast()) : null,
      pageCount: (out['page_count'] as num?)?.toInt() ?? 0,
      engineVersion: out['engine'] as String? ?? '',
      readMs: (out['read_ms'] as num?)?.toInt(),
      firstPage: out['first_page'] as String?,
    );
  }

  /// A model's answer to [RepairRequest] (its JSON schema), applied: a fix is
  /// kept only for a listed row that then closes; everything is checked again.
  RepairResult applyRepair(InvoiceState state, Map<String, dynamic> answer, {String context = ''}) {
    final out = call('apply_repair', {'state': state.json, 'answer': answer, 'context': context});
    return RepairResult(
      InvoiceDocument((out['document'] as Map).cast()),
      InvoiceState((out['state'] as Map).cast()),
      _maps(out['applied']),
      _maps(out['rejected']),
    );
  }

  /// One CSV line per item line (Excel: [bom] and [excelSafe]).
  String invoiceCsv(InvoiceState state, {bool bom = false, bool excelSafe = false}) =>
      call('invoice_csv', {'state': state.json, 'bom': bom, 'excel_safe': excelSafe})['csv'] as String;

  /// Text layer or scan, in milliseconds, without extracting.
  PdfClassification classify(Uint8List pdf) => PdfClassification(call('classify', const {}, pdf));

  /// The Markdown of [pages] (or all), with `<!-- Page N -->` markers.
  String processPdf(Uint8List pdf, {String tuning = '', List<int>? pages}) =>
      call('process_pdf', {'tuning': tuning, if (pages != null) 'pages': pages}, pdf)['markdown'] as String;

  List<Map<String, dynamic>> listKnobs() => _maps(call('list_knobs')['knobs']);

  String get version => call('version')['version'] as String;

  /// [readInvoice] in a fresh isolate (keeps the UI responsive).
  Future<InvoiceRead> readInvoiceAsync(Uint8List pdf, [ReadOptions options = const ReadOptions()]) {
    final path = _path;
    return Isolate.run(() => PdfInspectorHe.open(path: path).readInvoice(pdf, options));
  }

  /// [applyRepair] in a fresh isolate.
  Future<RepairResult> applyRepairAsync(InvoiceState state, Map<String, dynamic> answer, {String context = ''}) {
    final path = _path;
    return Isolate.run(() => PdfInspectorHe.open(path: path).applyRepair(state, answer, context: context));
  }

  static List<Map<String, dynamic>> _maps(Object? v) =>
      v is List ? v.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() : <Map<String, dynamic>>[];
}
