import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { createResultsWorkbook } from '../results-workbook.mjs';

test('creates readable results sheets and run metadata without interpreting formulas', async () => {
  const generatedAt = new Date('2026-11-02T15:00:00Z');
  const caption = '=HYPERLINK("https://example.invalid", "Example")';
  const buffer = await createResultsWorkbook(
    [{ name: 'image.png', caption }],
    [{ name: 'report.pdf', type: 'alt-text', figureIndex: 0, suggestion: 'A chart', status: 'suggested' }],
    'Test model',
    generatedAt,
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'Image Captions', 'PDF Results', 'Run Info',
  ]);
  const captions = workbook.getWorksheet('Image Captions');
  assert.equal(captions.getCell('B2').value, caption);
  assert.equal(captions.getCell('B2').type, ExcelJS.ValueType.String);
  assert.equal(captions.views[0].ySplit, 1);
  assert.ok(captions.autoFilter);
  assert.equal(captions.getCell('B2').alignment.wrapText, true);
  assert.equal(workbook.getWorksheet('PDF Results').getCell('D2').value, 0);
  assert.equal(workbook.getWorksheet('PDF Results').getCell('F2').value, 'A chart');
  assert.equal(workbook.getWorksheet('Run Info').getCell('B2').value, 'Test model');
  assert.equal(workbook.getWorksheet('Run Info').getCell('B3').value, generatedAt.toISOString());
});

test('creates all sheets and headers when there are no results', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createResultsWorkbook([], [], 'Test model'));

  assert.equal(workbook.getWorksheet('Image Captions').rowCount, 1);
  assert.equal(workbook.getWorksheet('PDF Results').rowCount, 1);
  assert.equal(workbook.getWorksheet('PDF Results').getCell('G1').value, 'status');
});