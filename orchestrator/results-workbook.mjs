import ExcelJS from 'exceljs';

export async function createResultsWorkbook(captionRows, pdfRows, modelName, generatedAt = new Date()) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Ethical AI Metadata Testing';
  workbook.created = generatedAt;

  const sheets = [
    {
      name: 'Image Captions',
      columns: ['name', 'caption'],
      rows: captionRows,
    },
    {
      name: 'PDF Results',
      columns: ['name', 'type', 'language', 'figureIndex', 'existingTitle', 'suggestion', 'status'],
      rows: pdfRows,
    },
    {
      name: 'Run Info',
      columns: ['field', 'value'],
      rows: [
        { field: 'Model', value: modelName },
        { field: 'Generated at (UTC)', value: generatedAt.toISOString() },
        { field: 'Image caption rows', value: captionRows.length },
        { field: 'PDF result rows', value: pdfRows.length },
      ],
    },
  ];

  for (const { name, columns, rows } of sheets) {
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.columns = columns.map((column) => ({
      header: column,
      key: column,
      width: ['caption', 'suggestion', 'value'].includes(column) ? 70 : 25,
    }));
    for (const row of rows) {
      sheet.addRow(columns.map((column) => {
        const value = row[column] ?? '';
        return typeof value === 'number' ? value : String(value);
      }));
    }
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: columns.length },
    };
    sheet.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });
    sheet.getRow(1).font = { bold: true };
  }

  return workbook.xlsx.writeBuffer();
}