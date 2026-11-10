/// Typed views over the invoice document (`pdf-inspector-he/invoice-document@1`,
/// he/invoice-document.schema.json). Every view keeps its raw JSON in [json],
/// so nothing the library adds later is lost on the way.
library;

enum InvoiceStatus {
  /// Every check closes.
  ok,

  /// A few rows (or a total) do not close: send [InvoiceDocument.repair].
  repairable,

  /// No item table, no text layer, or the table was read wrong as a whole.
  unreadable;

  static InvoiceStatus parse(Object? value) => switch (value) {
        'ok' => ok,
        'repairable' => repairable,
        _ => unreadable,
      };
}

double? _num(Object? v) => v is num ? v.toDouble() : null;
String? _str(Object? v) => v is String ? v : null;
List<Map<String, dynamic>> _maps(Object? v) =>
    v is List ? v.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() : const [];
List<int> _ints(Object? v) => v is List ? v.whereType<num>().map((n) => n.toInt()).toList() : const [];

/// The invoice's own facts; null where not found, never guessed.
class InvoiceFacts {
  InvoiceFacts(this.json);
  final Map<String, dynamic> json;

  /// `invoice`, `credit` (all lines negative) or `mixed`.
  String get documentType => _str(json['document_type']) ?? 'invoice';
  String? get invoiceNumber => _str(json['invoice_number']);

  /// ISO date (YYYY-MM-DD).
  String? get invoiceDate => _str(json['invoice_date']);
  String? get supplierName => _str(json['supplier_name']);
  String? get supplierTaxId => _str(json['supplier_tax_id']);
  double? get subtotal => _num(json['subtotal']);
  double? get discount => _num(json['discount']);
  double? get afterDiscount => _num(json['after_discount']);
  double? get vatRate => _num(json['vat_rate']);
  double? get vat => _num(json['vat']);
  double? get total => _num(json['total']);
  String? get currency => _str(json['currency']);
  bool get checksOk => json['checks_ok'] == true;
}

/// What is printed for whoever pays the invoice; null where not printed,
/// never guessed.
class InvoiceDetails {
  InvoiceDetails(this.json);
  final Map<String, dynamic> json;

  /// ISO date printed as a due date; payment terms alone give none.
  String? get dueDate => _str(json['due_date']);

  /// As printed: "שוטף + 30".
  String? get paymentTerms => _str(json['payment_terms']);
  String? get supplierPhone => _str(json['supplier_phone']);
  String? get supplierAddress => _str(json['supplier_address']);

  /// Bank number, branch and account for transfers, digits only: all three
  /// or none.
  String? get bankCode => _str(json['bank_code']);
  String? get bankBranch => _str(json['bank_branch']);
  String? get bankAccount => _str(json['bank_account']);

  /// מספר הקצאה, digits only: a labelled value, or the one nine-digit number
  /// printed by the label.
  String? get allocationNumber => _str(json['allocation_number']);

  /// The label is printed but the code could not decide: the numbers of 9+
  /// digits by it. A model may pick ONE OF THESE; empty when decided.
  List<String> get allocationCandidates =>
      (json['allocation_candidates'] as List? ?? const []).whereType<String>().toList();

  /// The label's line and the line under it, as printed.
  String? get allocationContext => _str(json['allocation_context']);
}

/// One item line, as printed (Hebrew already in reading order).
class InvoiceLine {
  InvoiceLine(this.json);
  final Map<String, dynamic> json;

  /// 1-based position in the document.
  int get row => (json['row'] as num).toInt();
  double? get lineNo => _num(json['line_no']);
  int get page => (json['page'] as num?)?.toInt() ?? 0;
  String? get date => _str(json['date']);
  String? get deliveryNote => _str(json['delivery_note']);
  String? get orderRef => _str(json['order_ref']);
  String? get sku => _str(json['sku']);
  String? get description => _str(json['description']);
  String? get siteText => _str(json['site_text']);
  double? get quantity => _num(json['quantity']);
  String? get unit => _str(json['unit']);
  double? get unitPrice => _num(json['unit_price']);
  double? get discountPct => _num(json['discount_pct']);
  double? get netUnitPrice => _num(json['net_unit_price']);

  /// Before VAT, as printed (negative on a return line).
  double? get lineTotal => _num(json['line_total']);
  String? get currency => _str(json['currency']);

  /// A marker line (0.00 / 0.01): evidence, not money.
  bool get marker => json['marker'] == true;
  bool get isReturn => json['is_return'] == true;

  /// Whether quantity × price closes to the total; null when it could not run.
  bool? get checkOk => json['check_ok'] is bool ? json['check_ok'] as bool : null;
  double? get checkDiff => _num(json['check_diff']);

  /// Why the row was corrected (by a repair answer), or null.
  String? get repaired => json['repaired'] is String ? json['repaired'] as String : (json['repaired'] == true ? '' : null);
  bool get inserted => json['inserted'] == true;
}

class InvoiceCheck {
  InvoiceCheck(this.json);
  final Map<String, dynamic> json;
  String get name => json['name'] as String;
  bool get ok => json['ok'] == true;
  double? get expected => _num(json['expected']);
  double? get actual => _num(json['actual']);
  double? get diff => _num(json['diff']);
}

class InvoiceTotal {
  InvoiceTotal(this.json);
  final Map<String, dynamic> json;
  String get label => json['label'] as String;

  /// subtotal / discount / afterDiscount / vat / total / rounding / balance / …
  String get role => json['role'] as String;
  double get value => (json['value'] as num).toDouble();
  double? get percent => _num(json['percent']);
  String? get currency => _str(json['currency']);
}

/// The compact request to send a model: the failing rows as CSV, the failed
/// checks and the totals in [prompt]; answer in [schema] (JSON Schema).
class RepairRequest {
  RepairRequest(this.json);
  final Map<String, dynamic> json;
  String get prompt => json['prompt'] as String;
  Map<String, dynamic> get schema => (json['schema'] as Map).cast<String, dynamic>();

  /// 1-based rows listed in the prompt (a fix to another row is refused).
  List<int> get rows => _ints(json['rows']);
  List<int> get pages => _ints(json['pages']);

  /// A row seems missing: attach these pages' images, text alone cannot fix it.
  bool get needsPages => json['needs_pages'] == true;
}

class InvoiceDocument {
  InvoiceDocument(this.json);
  final Map<String, dynamic> json;

  String get schema => json['schema'] as String;
  InvoiceStatus get status => InvoiceStatus.parse(json['status']);
  List<String> get reasons => (json['reasons'] as List? ?? const []).cast<String>();

  /// TextBased / Mixed / Scanned / ImageBased.
  String? get pdfType => _str((json['pdf'] as Map?)?['type']);
  InvoiceFacts? get invoice => json['invoice'] is Map ? InvoiceFacts((json['invoice'] as Map).cast()) : null;
  InvoiceDetails? get details => json['details'] is Map ? InvoiceDetails((json['details'] as Map).cast()) : null;
  List<InvoiceLine> get lines => _maps(json['lines']).map(InvoiceLine.new).toList();
  List<InvoiceTotal> get totals => _maps(json['totals']).map(InvoiceTotal.new).toList();
  List<InvoiceCheck> get checks => _maps(json['checks']).map(InvoiceCheck.new).toList();

  /// Header fields as label → value pairs, in reading order.
  List<MapEntry<String, String>> get headerFields =>
      _maps((json['header'] as Map?)?['fields']).map((f) => MapEntry(f['label'] as String, f['value'] as String)).toList();

  /// 1-based rows whose arithmetic does not close.
  List<int> get failedRows => _ints(json['failed_rows']);
  List<int> get repairedRows => _ints(json['repaired']);
  RepairRequest? get repair => json['repair'] is Map ? RepairRequest((json['repair'] as Map).cast()) : null;
  String? get markdown => _str(json['markdown']);
}

/// What [applyRepair] and [invoiceCsv] need back from a read. Opaque: keep
/// it as it came (it survives JSON, e.g. across an isolate or a restart).
class InvoiceState {
  InvoiceState(this.json);
  final Map<String, dynamic> json;
}

class InvoiceRead {
  InvoiceRead(this.document, this.state,
      {this.pageCount = 0, this.engineVersion = '', this.readMs, this.firstPage});
  final InvoiceDocument document;

  /// Null when there is no invoice (no text layer, or over the page limit).
  final InvoiceState? state;

  /// Pages in the document.
  final int pageCount;

  /// The native library's version.
  final String engineVersion;

  /// Wall time of the read inside the library, in milliseconds.
  final int? readMs;

  /// Page 1's Markdown, when asked with [ReadOptions.firstPage].
  final String? firstPage;
}

class RepairResult {
  RepairResult(this.document, this.state, this.applied, this.rejected);
  final InvoiceDocument document;
  final InvoiceState state;

  /// The fixes kept (each closes its row) and those refused, with `reason`.
  final List<Map<String, dynamic>> applied;
  final List<Map<String, dynamic>> rejected;
}

class PdfClassification {
  PdfClassification(this.json);
  final Map<String, dynamic> json;
  String get pdfType => json['pdf_type'] as String;
  int get pageCount => (json['page_count'] as num).toInt();

  /// Has a text layer the invoice reader can use.
  bool get hasText => pdfType == 'TextBased' || pdfType == 'Mixed';
}

class InvoiceReaderException implements Exception {
  InvoiceReaderException(this.method, this.message);
  final String method;
  final String message;
  @override
  String toString() => 'InvoiceReaderException($method): $message';
}
