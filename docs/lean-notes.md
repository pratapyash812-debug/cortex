# Using Cortex

Click **New note** and write. It adds a page to your current notebook or section. From **All notebooks**, it creates an unfiled quick note. **Saved** means the note write completed. If saving fails, keep the window open and use recovery rather than discarding the draft.

- **Notebooks:** open a subject such as Business Economics to see its numbered **Contents**. Choose a section, then a note. All subjects stay visible in the notebook shelf, with note counts. **All notebooks** returns to the complete shelf. The **+** beside **Your notebooks** creates a new notebook, with no placeholder notes. **New note in this notebook** opens a blank page ready to write. The path above a page takes you back to its parent contents.
- **Overview:** your existing introductory text and links remain in **Open overview note**. Opening a notebook's contents does not edit that text.
- **Subnotes:** click **Add subnote** beneath the toolbar. Small notebooks use tabs; larger ones use **Pages** so you do not need to hunt sideways. Click a note’s title to rename it. Each subnote has its own saved text.
- **Maths:** press **Alt+=** for an equation. Double-click a displayed equation to edit it.
- **Graphs and tables:** use **Insert → Graph / chart** or **Table**. Tables automatically have solid visible borders and a shaded header in dark and light mode; existing tables get the same treatment. Paste cells from Excel when useful; Cortex does not recalculate workbooks.
- **Drawing:** use **Insert → Sketch**. Sketch draws; Drag moves the view. Keep writing above and below the drawing.
- **Import:** choose **Import folder or files**, select your existing folder, and open the imported subject when it finishes. Original files are preserved. Word content becomes editable notes; long books get a contents note and smaller section subnotes. PowerPoint text, tables and supported embedded pictures become readable notes. Native slide charts, SmartArt, complex Word layouts and spreadsheet calculations may require the original application. Stored spreadsheet values are readable, but Cortex does not recalculate Excel formulas. Conversion limits and failures are reported.
- **Find:** Ctrl+K searches notes and PDF pages across your entire library, even when one notebook is selected. Press Escape in the library search to return to your notebooks. Choose a PDF result to open its matching page; use the page number, arrows or **Find in this PDF** to read further. Only one page is rendered at a time. PDF search runs locally after background indexing; progress and unavailable text are shown. Image-only scans need selectable text; Cortex does not perform OCR. Ctrl+F searches inside the current note or PDF.

## Keeping your work safe

Notes are stored in the laptop folder shown in **Settings & backup**. Cortex also creates verified versioned ZIP backups outside that folder, normally in `%LOCALAPPDATA%\Cortex\Backups\<notebook-id>`, keeping the latest seven. Changes are combined while you work; a stable backup is captured during idle time. **Back up now** first saves the current note and requests a verified backup. Settings shows the last verified time, destination and any error. A failed capture leaves previous valid copies intact.

These automatic copies still live on this laptop. Use **Download all notes & originals** and keep the ZIP on another drive or in your own cloud storage to protect against losing the device. Backups include originals, subnotes, sketches, history and `.cortex` metadata. Existing configured sync stays under Settings; Cortex does not automatically upload your folders anywhere.

**Note options → Version history** restores earlier writing. **Settings → Recover notes** contains Recently deleted, Unsaved drafts and Older content. Existing configured sync stays under Settings; Cortex does not automatically upload your folders anywhere.

To restore a ZIP backup, close Cortex, extract into a separate folder, and open it with the `--vault` launch option. Do not extract over an open notebook. Keep `.cortex` with the Markdown and attachments.
