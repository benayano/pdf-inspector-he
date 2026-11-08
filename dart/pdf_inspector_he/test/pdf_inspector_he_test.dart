// Against the native library built on the host:
//   (cd ffi && cargo build --release)
//   PDF_INSPECTOR_HE_LIB=$PWD/ffi/target/release/libpdf_inspector_he.so dart test
// The library path defaults to that build, so `dart test` alone works after it.
import 'dart:io';
import 'dart:typed_data';

import 'package:pdf_inspector_he/pdf_inspector_he.dart';
import 'package:test/test.dart';

final _repo = Directory.current.uri.resolve('../../');
Uint8List _pdf(String path) => File.fromUri(_repo.resolve(path)).readAsBytesSync();

String get _library =>
    Platform.environment['PDF_INSPECTOR_HE_LIB'] ??
    _repo.resolve('ffi/target/release/$libraryFileName').toFilePath();

void main() {
  late PdfInspectorHe engine;
  setUpAll(() => engine = PdfInspectorHe.open(path: _library));

  test('reads every corpus invoice and every check closes', () {
    final expected = {
      'he/fixtures/invoices/print-to-pdf-5p.pdf': null,
      'he/fixtures/invoices/priority-1p.pdf': 15,
      'he/fixtures/invoices/priority-2p.pdf': 38,
      'he/fixtures/invoices/priority-4p.pdf': 129,
    };
    for (final MapEntry(key: path, value: rows) in expected.entries) {
      final read = engine.readInvoice(_pdf(path));
      final doc = read.document;
      expect(doc.schema, 'pdf-inspector-he/invoice-document@1', reason: path);
      expect(doc.status, InvoiceStatus.ok, reason: '$path: ${doc.reasons}');
      expect(doc.invoice!.checksOk, isTrue, reason: path);
      if (rows != null) expect(doc.lines, hasLength(rows), reason: path);
      expect(doc.lines.every((l) => l.checkOk != false), isTrue, reason: path);
      expect(read.state, isNotNull);
    }
  });

  test('the same document as pdf2md --invoice-json (the golden)', () {
    final doc = engine.readInvoice(_pdf('he/fixtures/invoices/priority-1p.pdf')).document;
    final facts = doc.invoice!;
    expect(facts.invoiceNumber, isNotEmpty);
    expect(facts.invoiceDate, matches(RegExp(r'^\d{4}-\d{2}-\d{2}$')));
    expect(facts.supplierTaxId, matches(RegExp(r'^\d+$')));
    expect(facts.total, isNotNull);
    expect(doc.lines.where((l) => l.marker), isNotEmpty);
    expect(doc.lines.where((l) => l.isReturn), isNotEmpty);
    expect(doc.lines.first.description, contains(RegExp(r'[֐-׿]')));
  });

  test('a misread row: the request, a wrong fix refused, the right one closes', () {
    final read = engine.readInvoice(_pdf('he/fixtures/repair/priority-1p.misread-row11.pdf'));
    final doc = read.document;
    expect(doc.status, InvoiceStatus.repairable);
    expect(doc.failedRows, [11]);
    final request = doc.repair!;
    expect(request.prompt, contains('row 11: 1 x price != 27.35'));
    expect(request.schema['type'], 'object');
    expect(request.needsPages, isFalse);

    Map<String, dynamic> answer(double price) => {
          'fixes': [
            {'row': 11, 'quantity': 1, 'unit_price': price, 'discount_pct': 0, 'line_total': price, 'why': 'first digit read as 3'}
          ],
          'inserts': [],
          'unreadable': [],
          'notes': '',
        };
    final wrong = engine.applyRepair(read.state!, answer(37.35));
    expect(wrong.document.status, InvoiceStatus.repairable);

    final right = engine.applyRepair(read.state!, answer(27.35));
    expect(right.document.status, InvoiceStatus.ok, reason: '${right.document.reasons}');
    expect(right.applied, hasLength(1));
    expect(right.document.repairedRows, [11]);
    expect(right.document.lines[10].repaired, 'first digit read as 3');
    expect(engine.invoiceCsv(right.state).split('\n')[11], contains(',27.35,'));
  });

  test('errors are exceptions, not crashes', () {
    expect(() => engine.readInvoice(Uint8List.fromList('not a pdf'.codeUnits)), throwsA(isA<InvoiceReaderException>()));
    expect(() => engine.call('nope'), throwsA(isA<InvoiceReaderException>()));
    expect(() => engine.readInvoice(Uint8List(0)), throwsA(isA<InvoiceReaderException>()));
  });

  test('classify, markdown, knobs, version', () {
    final pdf = _pdf('he/fixtures/invoices/priority-2p.pdf');
    final c = engine.classify(pdf);
    expect(c.hasText, isTrue);
    expect(c.pageCount, 2);
    expect(engine.processPdf(pdf, pages: [2]), contains('<!-- Page 2 -->'));
    expect(engine.listKnobs().map((k) => k['name']), contains('latin_digit_split'));
    expect(engine.version, matches(RegExp(r'^\d+\.\d+\.\d+$')));
  });

  test('async reads run in another isolate', () async {
    final read = await engine.readInvoiceAsync(_pdf('he/fixtures/invoices/priority-1p.pdf'));
    expect(read.document.status, InvoiceStatus.ok);
  });
}
