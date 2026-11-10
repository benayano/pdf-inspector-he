/* pdf-inspector-he C ABI (ABI version 1). See ffi/src/lib.rs. */
#ifndef PDF_INSPECTOR_HE_H
#define PDF_INSPECTOR_HE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* JSON {"ok":true,"result":...} or {"ok":false,"error":"..."}; free with pdfhe_free. */
char *pdfhe_call(const char *method, const char *request, const uint8_t *bytes, size_t len);
void pdfhe_free(char *result);
uint32_t pdfhe_abi_version(void);
#ifdef __cplusplus
}
#endif
#endif
