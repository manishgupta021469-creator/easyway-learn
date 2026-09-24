Easyway Learn V54 fix

1. Same paragraph stays permanently qualified after first 80% unlock.
2. Read This Paragraph Again returns to the paragraph without revoking qualification.
3. Back to Speaking Test is available after rereading.
4. OCR language request uses hin+eng for Hindi environments and server falls back safely if Hindi traineddata is unavailable.
5. OCR paragraph extraction now returns structured paragraph objects instead of plain strings, so detected paragraphs are actually saved.
6. OCR paragraph splitting and chapter heading detection are more tolerant.

Replace app.js and server.js in the project. No service-worker change is required for this fix.
