export interface INyxStorage {
  get<T>(storeName: string, key: string): Promise<T | null>;
  set<T>(storeName: string, key: string, value: T): Promise<void>;
  remove(storeName: string, key: string): Promise<void>;
  clear(storeName: string): Promise<void>;
  getAll?<T>(storeName: string): Promise<T[]>;
}
