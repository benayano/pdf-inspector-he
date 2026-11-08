import 'dart:ffi';
import 'dart:io';

/// The native library's file name on this platform.
String get libraryFileName {
  if (Platform.isWindows) return 'pdf_inspector_he.dll';
  if (Platform.isMacOS) return 'libpdf_inspector_he.dylib';
  return 'libpdf_inspector_he.so';
}

class PdfInspectorHeLibraryException implements Exception {
  PdfInspectorHeLibraryException(this.message);
  final String message;
  @override
  String toString() => 'PdfInspectorHeLibraryException: $message';
}

/// Opens the native library: [path] if given, else `PDF_INSPECTOR_HE_LIB`,
/// else the platform's own lookup (Android: the APK's jniLibs; iOS: linked
/// into the process).
DynamicLibrary openLibrary([String? path]) {
  final explicit = path ?? Platform.environment['PDF_INSPECTOR_HE_LIB'];
  try {
    if (explicit != null && explicit.isNotEmpty) return DynamicLibrary.open(explicit);
    if (Platform.isIOS) return DynamicLibrary.process();
    return DynamicLibrary.open(libraryFileName);
  } on ArgumentError catch (e) {
    throw PdfInspectorHeLibraryException(
        'cannot load ${explicit ?? libraryFileName}: ${e.message}');
  }
}

typedef _CallC = Pointer<Char> Function(
    Pointer<Char> method, Pointer<Char> request, Pointer<Uint8> bytes, Size len);
typedef CallDart = Pointer<Char> Function(
    Pointer<Char> method, Pointer<Char> request, Pointer<Uint8> bytes, int len);
typedef _FreeC = Void Function(Pointer<Char>);
typedef FreeDart = void Function(Pointer<Char>);
typedef _AbiC = Uint32 Function();
typedef AbiDart = int Function();

/// The three C functions (ffi/src/lib.rs).
class Bindings {
  Bindings(DynamicLibrary lib)
      : call = lib.lookupFunction<_CallC, CallDart>('pdfhe_call'),
        free = lib.lookupFunction<_FreeC, FreeDart>('pdfhe_free'),
        abiVersion = lib.lookupFunction<_AbiC, AbiDart>('pdfhe_abi_version');

  final CallDart call;
  final FreeDart free;
  final AbiDart abiVersion;
}

/// The ABI this package was written against.
const int supportedAbiVersion = 1;
