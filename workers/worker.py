"""Fixed, bounded document/domain operations. Never a generic Python executor."""
import sys
sys.dont_write_bytecode = True
import contextlib
import csv
import importlib.util
import io
import json
from pathlib import Path
import re
import runpy
import zipfile
from urllib.parse import urlsplit
from urllib.request import url2pathname

MAX_TEXT = 300_000

def under(path, root):
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(Path(root).resolve()):
        raise ValueError('Path outside the owned runtime directory')
    return resolved

def inspect_zip(path):
    with zipfile.ZipFile(path) as archive:
        total = 0
        for item in archive.infolist():
            total += item.file_size
            if total > 100 * 1024 * 1024 or item.file_size > 30 * 1024 * 1024 or (item.compress_size and item.file_size / item.compress_size > 1000):
                raise ValueError('Office document exceeds safe decompression budget')

def parse_document(file):
    suffix = file.suffix.lower()
    sections = []
    metadata = {}
    partial = False
    if suffix == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(file)
        if reader.is_encrypted:
            raise ValueError('Encrypted PDF requires an unlocked, authorized copy')
        metadata['page_count'] = len(reader.pages)
        if len(reader.pages) > 300:
            raise ValueError('PDF exceeds the 300 page processing limit')
        for number, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ''
            sections.append({'locator': f'第{number}页', 'text': text})
            if len(text.strip()) < 10:
                partial = True
    elif suffix == '.docx':
        inspect_zip(file)
        from docx import Document
        document = Document(file)
        for number, paragraph in enumerate(document.paragraphs, 1):
            if paragraph.text.strip():
                sections.append({'locator': f'段落{number}', 'text': paragraph.text})
        for number, table in enumerate(document.tables, 1):
            sections.append({'locator': f'表格{number}', 'text': '\n'.join(' | '.join(cell.text for cell in row.cells) for row in table.rows)})
    elif suffix == '.xlsx':
        inspect_zip(file)
        from openpyxl import load_workbook
        workbook = load_workbook(file, read_only=True, data_only=True, keep_links=False)
        cells = 0
        try:
            for sheet in workbook.worksheets[:20]:
                lines = []
                for number, row in enumerate(sheet.iter_rows(values_only=True), 1):
                    cells += len(row)
                    if cells > 50_000:
                        partial = True
                        break
                    lines.append(str(number) + ': ' + ' | '.join('' if value is None else str(value) for value in row))
                sections.append({'locator': '工作表 ' + sheet.title, 'text': '\n'.join(lines)})
                if partial:
                    break
            if len(workbook.worksheets) > 20:
                partial = True
        finally:
            workbook.close()
        metadata['formula_note'] = 'Cached values only; formulas were not executed and missing cached values remain unknown.'
    elif suffix in ('.txt', '.md', '.csv'):
        data = file.read_bytes()
        try:
            text = data.decode('utf-8-sig')
            metadata['encoding'] = 'utf-8'
        except UnicodeDecodeError:
            text = data.decode('gb18030')
            metadata['encoding'] = 'gb18030'
        if suffix == '.csv':
            rows = csv.reader(io.StringIO(text))
            text = '\n'.join(str(index) + ': ' + ' | '.join(row) for index, row in enumerate(rows, 1))
        sections.append({'locator': '全文／行号', 'text': text})
    else:
        raise ValueError('Unsupported document type')
    remaining = MAX_TEXT
    output = []
    for section in sections:
        if remaining <= 0:
            partial = True
            break
        text = section['text']
        if len(text) > remaining:
            text = text[:remaining]
            partial = True
        output.append({'locator': section['locator'], 'text': text})
        remaining -= len(text)
    text = '\n\n'.join('[' + row['locator'] + ']\n' + row['text'] for row in output)
    return {'text': text, 'sections': output, 'partial': partial, 'needs_visual': suffix == '.pdf' and (partial or not text.strip()), 'metadata': metadata}

def reject_local_references(value, allowed=()):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ('id', 'subdir') and isinstance(item, str) and not re.fullmatch(r'[\w.:-]{1,160}', item):
                raise ValueError('Rendered IDs and subdirectories must use safe identifier characters')
            reject_local_references(item, allowed)
    elif isinstance(value, list):
        for item in value:
            reject_local_references(item, allowed)
    elif isinstance(value, str):
        if value in allowed:
            return
        if re.search(r'file\s*:', value, re.I) or re.match(r'^[A-Za-z]:[\\/]|^\\\\|^/(?!/)', value) or re.search(r'(?:^|[\\/])\.\.(?:[\\/]|$)', value):
            raise ValueError('Domain input cannot contain arbitrary local file references')
        if re.match(r'^\s*(javascript|vbscript|data)\s*:', value, re.I):
            raise ValueError('Active URL schemes are not allowed in report inputs')

def cli(script, args):
    old = sys.argv
    sys.argv = [str(script), *[str(arg) for arg in args]]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                runpy.run_path(str(script), run_name='__main__')
            except SystemExit as error:
                if error.code not in (None, 0):
                    raise ValueError('Domain validator/renderer rejected the supplied data') from error
    finally:
        sys.argv = old

def domain_operation(request, root, output):
    domain = request['domain']
    operation = request['operation']
    data = request['data']
    allowed = request.get('allowed_local_uris', [])
    for uri in allowed:
        parsed = urlsplit(uri)
        if parsed.scheme != 'file' or parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError('Invalid host-bound local source')
        under(url2pathname(parsed.path), request['allowed_root'])
    reject_local_references(data, allowed)
    input_file = output / 'input.json'
    input_file.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    if domain == 'market':
        sys.path.insert(0, str(root / 'scripts'))
        if operation not in ('validate', 'render'):
            raise ValueError('Unsupported market operation')
        args = [operation, '--data', input_file]
        if operation == 'render':
            args += ['--out', output / 'report']
        cli(root / 'scripts/research.py', args)
        return {'validated': True, 'rendered': operation == 'render'}
    if domain == 'enterprise':
        if operation != 'match':
            raise ValueError('Only the offline enterprise condition/window operation is exposed')
        module = runpy.run_path(str(root / 'scripts/policy_watch.py'))
        profile, policies = data['profile'], data['policies']
        result = {'as_of': request['as_of'], 'company_name': profile.get('company_name'), 'matches': [module['screen'](profile, policy, request['as_of']) for policy in policies]}
        (output / 'match.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        return result
    if domain == 'domestic':
        if operation != 'render':
            raise ValueError('Unsupported domestic operation')
        cli(root / 'tools/render-job-report.py', ['--data', input_file, '--out', output / 'report'])
        return {'rendered': True, 'rubric': '3.0'}
    if domain == 'international':
        if operation == 'evaluate':
            evaluate = runpy.run_path(str(root / 'tools/evaluate-international.py'))['evaluate']
            result = [evaluate(item) for item in data] if isinstance(data, list) else evaluate(data)
            (output / 'evaluation.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            return {'assessment': result, 'rubric': '2.0'}
        if operation == 'render':
            cli(root / 'tools/render-international-dual.py', ['--data', input_file, '--out', output / 'report'])
            for file in (output / 'report').rglob('*.csv'):
                rows = list(csv.reader(io.StringIO(file.read_text(encoding='utf-8-sig'))))
                with file.open('w', encoding='utf-8-sig', newline='') as stream:
                    csv.writer(stream).writerows([["'" + cell if re.match(r'^\s*[=+@-]', cell) else cell for cell in row] for row in rows])
            return {'rendered': True, 'rubric': '2.0', 'csv_formula_protection': True}
    raise ValueError('Unsupported registered operation')

def main():
    raw = sys.stdin.buffer.read(12 * 1024 * 1024 + 1)
    if len(raw) > 12 * 1024 * 1024:
        raise ValueError('Worker input too large')
    request = json.loads(raw.decode('utf-8'))
    allowed = Path(request['allowed_root']).resolve()
    if request['operation'] == 'parse_document':
        file = under(request['input_file'], allowed)
        if file.stat().st_size > 20 * 1024 * 1024:
            raise ValueError('Document exceeds 20 MiB')
        result = parse_document(file)
    else:
        output = under(request['out_dir'], allowed)
        output.mkdir(parents=True, exist_ok=False)
        method = Path(request['method_root']).resolve()
        result = domain_operation(request, method, output)
    print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
