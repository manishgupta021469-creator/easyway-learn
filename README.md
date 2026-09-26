# Easyway Learn — Clean Rebuild v1.0

This package is a clean rebuild baseline for the OCR + Reading + Speaking assessment pipeline, based on the latest Easyway Learn Master Specification supplied by the owner.

## Deploy
1. Upload this ZIP to the GitHub repository and replace the current app files, or upload the files directly to the existing Render service repository.
2. Keep the existing Docker deployment.
3. Deploy from `main`.
4. After deployment open `/api/ocr-status`. It must report `ok:true`, `ocr:true`, `eng:true`, `hin:true`.
5. Test a clear English page, a clear Hindi page, and a mixed page before adding real student content.

## Important storage note
The local SQLite/JSON storage in this package is an application storage layer, not a promise of permanent storage on Render Free. For permanent cross-deploy student history, connect an external persistent database before production use.

## OCR design
- Stateless OCR endpoint: no Student login is required for OCR processing.
- JPEG/PNG/WebP and PDF supported.
- Text PDFs use embedded text first.
- Scanned PDFs are rendered at high DPI.
- Images are normalized/upscaled and multiple OCR passes are compared.
- Hindi + English are evaluated separately and together; script-aware selection prevents an English result from replacing a valid Hindi result.
- Paragraph extraction is deterministic and preserves the full OCR text for manual correction.
