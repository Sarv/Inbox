import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { extractAssistantAttachment } from '../../../../electron/services/assistant-attachment-extractor';
import { ASSISTANT_ATTACHMENT_LIMITS as LIMIT } from '../../../../electron/services/assistant-attachment-types';

function office(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
}

function pdf(text?: string, encrypted = false): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? '/Encrypt 6 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]' : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(output);
}

describe('assistant document evidence extraction', () => {
  it('reads quotation text from a real PDF with its page locator', async () => {
    const result = await extractAssistantAttachment({ filename: 'TCS quote.pdf', bytes: pdf('TCS quotation Q-2026-18 Total INR 250000 plus GST') });
    expect(result.status).toBe('ready');
    expect(result.segments[0]).toMatchObject({ text: expect.stringContaining('INR 250000'), locator: { kind: 'page', page: 1, label: 'Page 1' } });
  });

  it('reports a PDF without text as an explicit OCR coverage gap', async () => {
    expect((await extractAssistantAttachment({ filename: 'scan.pdf', bytes: pdf() })).status).toBe('scanned');
  });

  it('reports a password-protected PDF without claiming its quotation is absent', async () => {
    expect((await extractAssistantAttachment({ filename: 'locked.pdf', bytes: pdf('secret quote', true) })).status).toBe('password_protected');
  });

  it('reads DOCX runs, tables and escaped text without inventing page numbers', async () => {
    const bytes = office({ 'word/document.xml': '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>TCS &amp; Sons</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Total: INR 300000</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
    const result = await extractAssistantAttachment({ filename: 'quote.docx', bytes });
    expect(result.status).toBe('ready');
    expect(result.segments).toEqual([
      { text: 'TCS & Sons', locator: { kind: 'paragraph', paragraph: 1, label: 'Paragraph 1' } },
      { text: 'Total: INR 300000', locator: { kind: 'paragraph', paragraph: 2, label: 'Paragraph 2' } },
    ]);
  });

  it('omits deleted quotation amounts and Word field instructions from the current document', async () => {
    const bytes = office({ 'word/document.xml': '<w:document xmlns:w="urn:word"><w:body><w:p><w:del><w:r><w:delText>Old INR 900000</w:delText></w:r></w:del><w:r><w:instrText>INCLUDETEXT https://evil.invalid/quote</w:instrText></w:r><w:ins><w:r><w:t>Final INR 300000</w:t></w:r></w:ins></w:p></w:body></w:document>' });
    const result = await extractAssistantAttachment({ filename: 'quote.docx', bytes });
    expect(result.segments[0].text).toBe('Final INR 300000');
  });

  it('reads XLSX shared and inline strings, formula cached values, and sheet row evidence', async () => {
    const bytes = office({
      'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Quotation &amp; GST" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Annual service</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Service</t></is></c><c r="B1" t="inlineStr"><is><t>INR before GST</t></is></c></row><row r="4"><c r="A4" t="s"><v>0</v></c><c r="B4"><f>100000*3</f><v>300000</v></c></row></sheetData></worksheet>',
    });
    const result = await extractAssistantAttachment({ filename: 'quote.xlsx', bytes });
    expect(result.status).toBe('ready');
    expect(result.segments[1]).toEqual({ text: 'A4: Annual service | B4: 300000', locator: { kind: 'sheet', sheet: 'Quotation & GST', rowStart: 4, rowEnd: 4, label: 'Quotation & GST, row 4' } });
    expect(JSON.stringify(result)).not.toContain('100000*3');
  });

  it('does not follow XLSX external relationships or expose formulas as values', async () => {
    const bytes = office({
      'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Remote" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="https://evil.invalid/quote.xml" TargetMode="External"/></Relationships>',
    });
    expect((await extractAssistantAttachment({ filename: 'quote.xlsx', bytes })).status).toBe('empty');
  });

  it('keeps CSV/TXT line references and supports UTF-16 exports', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Company,Total\r\nTCS,250000', 'utf16le')]);
    const result = await extractAssistantAttachment({ filename: 'quote.csv', bytes });
    expect(result.segments[1]).toEqual({ text: 'TCS,250000', locator: { kind: 'line', lineStart: 2, lineEnd: 2, label: 'Line 2' } });
  });

  it('rejects XML entities and traversal entries before extraction', async () => {
    const malicious = office({ 'word/document.xml': '<!DOCTYPE document [<!ENTITY x SYSTEM "file:///etc/passwd">]><document><p>&x;</p></document>' });
    expect((await extractAssistantAttachment({ filename: 'quote.docx', bytes: malicious })).status).toBe('malformed');
    const traversal = office({ '../word/document.xml': '<document/>' });
    expect((await extractAssistantAttachment({ filename: 'quote.docx', bytes: traversal })).status).toBe('malformed');
  });

  it('rejects expanded ZIP bombs and oversized input before parsing', async () => {
    const bomb = office({ 'word/document.xml': 'x'.repeat(LIMIT.xmlEntryBytes + 1) });
    expect((await extractAssistantAttachment({ filename: 'quote.docx', bytes: bomb })).status).toBe('too_large');
    expect((await extractAssistantAttachment({ filename: 'quote.pdf', bytes: new Uint8Array(LIMIT.bytes + 1) })).status).toBe('too_large');
  });

  it('reports encrypted Office containers, unsupported files and corrupt documents honestly', async () => {
    expect((await extractAssistantAttachment({ filename: 'locked.docx', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) })).status).toBe('password_protected');
    expect((await extractAssistantAttachment({ filename: 'quote.exe', bytes: strToU8('not executed') })).status).toBe('unsupported');
    expect((await extractAssistantAttachment({ filename: 'broken.pdf', bytes: strToU8('not a pdf') })).status).toBe('malformed');
    expect((await extractAssistantAttachment({ filename: 'broken.xlsx', bytes: strToU8('not a zip') })).status).toBe('malformed');
  });

  it('caps output and marks the source incomplete instead of silently dropping content', async () => {
    const result = await extractAssistantAttachment({ filename: 'long.txt', bytes: strToU8('x'.repeat(LIMIT.characters + 200)) });
    expect(result.status).toBe('ready');
    expect(result.truncated).toBe(true);
    expect(result.segments.reduce((sum, segment) => sum + segment.text.length, 0)).toBe(LIMIT.characters);
  });

  it('honours cancellation without parser errors or file paths', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await extractAssistantAttachment({ filename: 'quote.txt', bytes: strToU8('TCS'), signal: controller.signal });
    expect(result).toEqual({ status: 'cancelled', segments: [], truncated: false, message: 'Attachment reading was cancelled.' });
  });
});
