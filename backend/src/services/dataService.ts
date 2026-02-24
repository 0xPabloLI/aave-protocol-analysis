import { readFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MarketWithSpread, TokenPricesIndex } from '../types/index.js';
import { logger } from '../logger.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
const RUNTIME_DATA_DIR = join(DATA_DIR, 'runtime');
const DATA_FILE_PATH = join(RUNTIME_DATA_DIR, 'aave-formatted-data.json');
const LEGACY_DATA_FILE_PATH = join(DATA_DIR, 'aave-formatted-data.json');
const STALE_THRESHOLD_MS = 1 * 60 * 1000; // 1 minute in milliseconds

class DataService {
  private cache: MarketWithSpread[] | null = null;
  private lastCacheUpdate: Date | null = null;
  private fileMtime: Date | null = null;
  private dataTimestamp: Date | null = null; // 从数据文件中读取的时间戳
  private tokenPrices: TokenPricesIndex | null = null;

  /**
   * 从文件读取数据并加载到内存缓存
   */
  async loadData(): Promise<MarketWithSpread[]> {
    try {
      let filePathUsed = DATA_FILE_PATH;
      let fileContent: string;
      try {
        fileContent = await readFile(DATA_FILE_PATH, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        filePathUsed = LEGACY_DATA_FILE_PATH;
        fileContent = await readFile(LEGACY_DATA_FILE_PATH, 'utf-8');
        logger.warn(`Using legacy data file path fallback: ${LEGACY_DATA_FILE_PATH}`);
      }
      const parsed = JSON.parse(fileContent);
      
      // 检查是否是新格式（包含 _metadata）
      let data: any[];
      if (parsed._metadata && parsed.data) {
        // 新格式：包含元数据
        data = parsed.data;
        if (parsed.tokenPrices) {
          this.tokenPrices = parsed.tokenPrices as TokenPricesIndex;
        } else {
          this.tokenPrices = null;
        }
        // 从元数据中读取时间戳
        if (parsed._metadata.timestamp) {
          this.dataTimestamp = new Date(parsed._metadata.timestamp);
        }
      } else if (Array.isArray(parsed)) {
        // 旧格式：直接是数组（向后兼容）
        data = parsed;
        this.dataTimestamp = null;
        this.tokenPrices = null;
      } else {
        throw new Error('Invalid data file format');
      }
      
      // 直接使用数据，不需要计算 apySpread（前端自己计算）
      const dataWithSpread: MarketWithSpread[] = data;

      this.cache = dataWithSpread;
      this.lastCacheUpdate = new Date();
      
      // 获取文件修改时间（作为后备方案）
      const fileStats = await stat(filePathUsed);
      this.fileMtime = fileStats.mtime;

      return dataWithSpread;
    } catch (error) {
      if (error instanceof Error && (error as any).code === 'ENOENT') {
        // 文件不存在，返回空数组
        logger.warn(`Data file not found: ${DATA_FILE_PATH} (or legacy ${LEGACY_DATA_FILE_PATH})`);
        return [];
      }
      throw error;
    }
  }

  /**
   * 获取缓存的数据（如果缓存为空，则从文件加载）
   */
  async getData(): Promise<MarketWithSpread[]> {
    if (this.cache === null) {
      return await this.loadData();
    }
    return this.cache;
  }

  /**
   * 刷新缓存（重新从文件加载）
   */
  async refreshCache(): Promise<void> {
    await this.loadData();
  }

  /**
   * 获取最后更新时间
   * 优先使用数据文件中的时间戳，如果没有则使用文件修改时间或缓存更新时间
   */
  getLastUpdated(): Date | null {
    return this.dataTimestamp || this.fileMtime || this.lastCacheUpdate;
  }

  /**
   * 检查数据是否过期（超过1分钟）
   */
  isStale(): boolean {
    const lastUpdated = this.getLastUpdated();
    if (!lastUpdated) {
      return true;
    }
    const now = new Date();
    const age = now.getTime() - lastUpdated.getTime();
    return age > STALE_THRESHOLD_MS;
  }

  getTokenPrices(): TokenPricesIndex | null {
    return this.tokenPrices;
  }
}

export const dataService = new DataService();
