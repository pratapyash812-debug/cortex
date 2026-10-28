"""Small fixture checks for import formats whose exports have known quirks."""
import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import html_import
import notion_import  # noqa: E402


def archive(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


class NotionImportTests(unittest.TestCase):
    def test_page_heading_strips_export_id_and_csv_title_relates(self):
        page_id = "0123456789abcdef0123456789abcdef"
        files = {
            f"Export/Alpha {page_id}.md": f"# Alpha {page_id}\nBody\n".encode(),
            f"Export/DB {page_id}.csv": b"Name,Status\nAlpha,Done\n",
            f"Export/DB {page_id}_all.csv": b"Name,Status\nAlpha,Done\n",
        }
        result = notion_import.convert(archive(files))
        page = result["Notion import/Export/Alpha.md"]
        db = result["Notion import/Export/DB.md"]
        self.assertTrue(page.startswith("Body\n"))
        self.assertNotIn(page_id, page)
        self.assertIn("[[Alpha]]", db)
        self.assertEqual(result["__stats__"]["databases"], 1)

    def test_mht_embeds_absolute_content_location_image(self):
        data = (
            b'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="x"\r\n\r\n'
            b"--x\r\nContent-Type: text/html\r\nContent-Location: http://example.test/a.html\r\n\r\n"
            b'<html><title>T</title><img src="http://example.test/p.png"></html>\r\n'
            b"--x\r\nContent-Type: image/png\r\nContent-Location: http://example.test/p.png\r\n\r\nPNG\r\n"
            b"--x--\r\n"
        )
        result = html_import.convert(data, "page.mht")
        page = result["HTML import/T.md"]
        self.assertIn("![[p.png]]", page)
        self.assertEqual(result["__stats__"]["attachments"], 1)
        self.assertEqual(result["HTML import/attachments/p.png"], b"PNG")


if __name__ == "__main__":
    unittest.main()
