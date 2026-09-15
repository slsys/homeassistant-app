import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'gateways.json');
    this.entries = [];
    this.pending = Promise.resolve();
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const document = JSON.parse(await readFile(this.file, 'utf8'));
      if (document.version !== 1 || !Array.isArray(document.gateways))
        throw new Error('Unsupported gateway store');
      this.entries = document.gateways;
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Не удалось прочитать gateways.json; файл сохранён без изменений');
    }
  }
  save() {
    const contents = JSON.stringify({ version: 1, gateways: this.entries }, null, 2);
    const write = async () => {
      await writeFile(`${this.file}.tmp`, contents, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    };
    this.pending = this.pending.catch(() => {}).then(write);
    return this.pending;
  }
}
