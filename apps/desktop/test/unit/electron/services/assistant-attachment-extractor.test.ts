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
    expect(result.segments[1]).toEqual({ text: 'A4 [Service]: Annual service | B4 [INR before GST]: 300000 (saved formula value)', locator: { kind: 'sheet', sheet: 'Quotation & GST', rowStart: 4, rowEnd: 4, cellRange: 'A4:B4', label: 'Quotation & GST!A4:B4' } });
    expect(result.message).toContain('formulas were not recalculated');
    expect(JSON.stringify(result)).not.toContain('100000*3');
  });

  it('does not follow XLSX external relationships or expose formulas as values', async () => {
    const bytes = office({
      'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Remote" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="https://evil.invalid/quote.xml" TargetMode="External"/></Relationships>',
    });
    expect((await extractAssistantAttachment({ filename: 'quote.xlsx', bytes })).status).toBe('empty');
  });

  it('preserves later sheet totals and evaluation caveats despite hundreds of blank-input formula rows', async () => {
    const padding = Array.from({ length: 600 }, (_, i) => `<row r="${i + 10}"><c r="K${i + 10}"><f>F${i + 10}*G${i + 10}</f><v>0</v></c></row>`).join('');
    const bytes = office({
      'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Software" r:id="r1"/><sheet name="Summary" r:id="r2"/><sheet name="Read Me" r:id="r3"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/a.xml"/><Relationship Id="r2" Target="worksheets/b.xml"/><Relationship Id="r3" Target="worksheets/c.xml"/></Relationships>',
      'xl/worksheets/a.xml': `<worksheet><sheetData>${padding}</sheetData></worksheet>`,
      'xl/worksheets/b.xml': '<worksheet><sheetData><row r="17"><c r="C17" t="inlineStr"><is><t>Total Bid Value including GST</t></is></c><c r="D17"><f>SUM(D12:D16)</f><v>123456789.12</v></c></row><row r="18"><c r="C18" t="inlineStr"><is><t>Infrastructure inputs unpopulated</t></is></c><c r="D18"><f>SUM(A1:A3)</f><v>0</v></c></row></sheetData></worksheet>',
      'xl/worksheets/c.xml': '<worksheet><sheetData><row r="8"><c r="C8" t="inlineStr"><is><t>Infrastructure is included in evaluation TBV but excluded from payable TCV.</t></is></c></row><row r="9"><c r="C9" t="inlineStr"><is><t>Dummy seat quantities are only for evaluation. Actual efforts govern payments.</t></is></c></row></sheetData></worksheet>',
    });
    const result = await extractAssistantAttachment({ filename: 'final.xlsx', bytes });
    expect(result.status).toBe('ready');
    expect(result.truncated).toBe(false);
    expect(result.segments).toHaveLength(4);
    expect(result.segments[0]).toMatchObject({ text: expect.stringContaining('123456789.12'), locator: { label: 'Summary!C17:D17', cellRange: 'C17:D17' } });
    expect(result.segments[1].text).toContain('D18: 0 (saved formula value)');
    expect(result.segments[2].text).toContain('excluded from payable TCV');
    expect(result.segments[3].text).toContain('Actual efforts govern payments');
  });

  it('reserves space for later sheets and keeps totals when dense details exceed the reading budget', async () => {
    const dense = Array.from({ length: 650 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>Detail item ${i + 1}</t></is></c><c r="B${i + 1}"><v>100</v></c></row>`).join('');
    const bytes = office({
      'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Detail" r:id="r1"/><sheet name="Caveats" r:id="r2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/a.xml"/><Relationship Id="r2" Target="worksheets/b.xml"/></Relationships>',
      'xl/worksheets/a.xml': `<worksheet><sheetData>${dense}<row r="1000"><c r="A1000" t="inlineStr"><is><t>Total including GST</t></is></c><c r="B1000"><v>65000</v></c></row></sheetData></worksheet>`,
      'xl/worksheets/b.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Dummy inputs for evaluation only; payment based on actual effort.</t></is></c></row></sheetData></worksheet>',
    });
    const result = await extractAssistantAttachment({ filename: 'dense.xlsx', bytes });
    expect(result.truncated).toBe(true);
    expect(result.segments.some(s => s.locator.cellRange === 'A1000:B1000')).toBe(true);
    expect(result.segments.at(-1)?.text).toContain('payment based on actual effort');
    expect(result.segments.length).toBeLessThanOrEqual(LIMIT.segments);
    expect(result.segments.reduce((size, s) => size + s.text.length, 0)).toBeLessThanOrEqual(LIMIT.characters);
  });

  it('never evaluates a formula with no saved value or treats it as zero', async () => {
    const bytes = office({
      'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Quote" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/a.xml"/></Relationships>',
      'xl/worksheets/a.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1"><f>WEBSERVICE("https://evil.invalid")</f></c></row></sheetData></worksheet>',
    });
    const result = await extractAssistantAttachment({ filename: 'uncached.xlsx', bytes });
    expect(result.truncated).toBe(true);
    expect(result.segments[0].text).toContain('saved formula result unavailable');
    expect(JSON.stringify(result)).not.toContain('WEBSERVICE');
    expect(JSON.stringify(result)).not.toContain('evil.invalid');
  });

  it('retains explicit and cross-row zero results rather than mistaking them for blank-input padding', async () => {
    const bytes = office({
      'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Zeros" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/a.xml"/></Relationships>',
      'xl/worksheets/a.xml': '<worksheet><sheetData><row r="1"><c r="A1"><f>1-1</f><v>0</v></c></row><row r="2"><c r="A2"><f>SUM(A1)</f><v>0</v></c></row><row r="3"><c r="A3"><v>0</v></c></row><row r="4"><c r="A4"><f>C4*D4</f><v>0</v></c></row></sheetData></worksheet>',
    });
    const result = await extractAssistantAttachment({ filename: 'zeros.xlsx', bytes });
    expect(result.truncated).toBe(false);
    expect(result.segments.map(segment => segment.locator.rowStart)).toEqual([1, 2, 3]);
  });

  it('reads PPTX text in presentation order with slide references while ignoring external content', async () => {
    const bytes = office({
      'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/><p:sldId r:id="r3"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/><Relationship Id="r3" Target="https://evil.invalid/slide.xml" TargetMode="External"/></Relationships>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Technical sizing: 160 seats</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>EPFO &amp; TCS architecture</a:t></a:r></a:p><a:p><a:r><a:t>On-premise deployment</a:t></a:r></a:p></p:sld>',
      'ppt/notesSlides/notesSlide1.xml': '<notes>Not extracted speaker notes</notes>',
      'ppt/embeddings/macro.bin': 'never executed',
    });
    const result = await extractAssistantAttachment({ filename: 'technical.pptx', bytes });
    expect(result.segments).toEqual([
      { text: 'EPFO & TCS architecture\nOn-premise deployment', locator: { kind: 'slide', slide: 1, label: 'Slide 1' } },
      { text: 'Technical sizing: 160 seats', locator: { kind: 'slide', slide: 2, label: 'Slide 2' } },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.message).toContain('speaker notes');
    expect(JSON.stringify(result)).not.toContain('evil.invalid');
    expect(JSON.stringify(result)).not.toContain('never executed');
  });

  it('enforces Office ZIP and XML security limits for PPTX too', async () => {
    const files = {
      'ppt/presentation.xml': '<!DOCTYPE p [<!ENTITY leak SYSTEM "file:///etc/passwd">]><presentation/>',
      'ppt/_rels/presentation.xml.rels': '<Relationships/>',
    };
    expect((await extractAssistantAttachment({ filename: 'malicious.pptx', bytes: office(files) })).status).toBe('malformed');
    files['ppt/presentation.xml'] = 'x'.repeat(LIMIT.xmlEntryBytes + 1);
    expect((await extractAssistantAttachment({ filename: 'bomb.pptx', bytes: office(files) })).status).toBe('too_large');
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
