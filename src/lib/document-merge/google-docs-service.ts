/**
 * Document Merge Engine — Google Docs Service
 * 
 * Interface cho Google Docs/Drive API integration.
 * Hiện tại là mock implementation - cần Google Cloud credentials để hoạt động thật.
 */

import { extractUniquePlaceholders, replaceMultiplePlaceholders } from './placeholder-extractor';

/** Google Docs service interface */
export interface GoogleDocsService {
  /** Lấy nội dung document */
  getDocumentContent(docId: string): Promise<string>;
  
  /** Copy document */
  copyDocument(docId: string, folderId?: string): Promise<string>;
  
  /** Cập nhật document content */
  updateDocumentContent(docId: string, content: string): Promise<void>;
  
  /** Tạo document mới */
  createDocument(title: string, content: string, folderId?: string): Promise<string>;
  
  /** Kiểm tra document có tồn tại không */
  documentExists(docId: string): Promise<boolean>;
  
  /** Lấy permissions của document */
  getDocumentPermissions(docId: string): Promise<string[]>;
}

/** Mock Google Docs Service - sử dụng khi chưa có credentials */
export class MockGoogleDocsService implements GoogleDocsService {
  private documents: Map<string, { title: string; content: string }> = new Map();
  
  async getDocumentContent(docId: string): Promise<string> {
    const doc = this.documents.get(docId);
    if (!doc) {
      // Mock template content với placeholders
      return `
HỌ TÊN: <<Ho_ten>>
NGÀY SINH: <<Ngay_sinh>>
SỐ CCCD: <<So_CCCD>>
ĐỊA CHỈ: <<Dia_chi>>
NGÀY ĐĂNG KÝ: <<Ngay_dang_ky>>
BỘ PHẬN: <<Bo_phan>>
<<Gioi_tinh_Nam>> Nam
<<Gioi_tinh_Nu>> Nữ
`;
    }
    return doc.content;
  }
  
  async copyDocument(docId: string, _folderId?: string): Promise<string> {
    const sourceDoc = await this.getDocumentContent(docId);
    const newId = `mock_copy_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.documents.set(newId, {
      title: `Copy of ${docId}`,
      content: sourceDoc,
    });
    return newId;
  }
  
  async updateDocumentContent(_docId: string, _content: string): Promise<void> {
    // Mock implementation - không làm gì
  }
  
  async createDocument(title: string, content: string, _folderId?: string): Promise<string> {
    const docId = `mock_new_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.documents.set(docId, { title, content });
    return docId;
  }
  
  async documentExists(docId: string): Promise<boolean> {
    // Mock - coi như template IDs bắt đầu bằng số là tồn tại
    return /^\d/.test(docId);
  }
  
  async getDocumentPermissions(_docId: string): Promise<string[]> {
    return ['anyone'];
  }
}

/** Real Google Docs Service - cần Google Cloud credentials */
export class RealGoogleDocsService implements GoogleDocsService {
  private accessToken: string;
  private baseUrl = 'https://docs.googleapis.com/v1';
  private driveUrl = 'https://www.googleapis.com/drive/v3';
  
  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }
  
  private async fetch<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error: ${response.status} - ${error}`);
    }
    
    return response.json();
  }
  
  async getDocumentContent(docId: string): Promise<string> {
    // Export as plain text
    const response = await fetch(
      `${this.baseUrl}/documents/${docId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [{
            exportOptions: {
              exportFormat: 'TEXT',
            },
          }],
        }),
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to get document content: ${response.status}`);
    }
    
    // Return raw text content
    return response.text();
  }
  
  async copyDocument(docId: string, folderId?: string): Promise<string> {
    const body: Record<string, unknown> = {
      name: `Merge_${Date.now()}`,
    };
    
    if (folderId) {
      body.parents = [folderId];
    }
    
    const result = await this.fetch<{ id: string }>(
      `${this.driveUrl}/files/${docId}/copy`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
    
    return result.id;
  }
  
  async updateDocumentContent(docId: string, content: string): Promise<void> {
    // Use batchUpdate to replace content
    await this.fetch(`${this.baseUrl}/documents/${docId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            replaceAllText: {
              replaceText: content,
              containsText: {
                matchCase: true,
              },
            },
          },
        ],
      }),
    });
  }
  
  async createDocument(title: string, content: string, folderId?: string): Promise<string> {
    // Tạo document mới
    const fileMetadata: Record<string, unknown> = {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
    };
    
    if (folderId) {
      fileMetadata.parents = [folderId];
    }
    
    const formData = new FormData();
    formData.append('metadata', JSON.stringify(fileMetadata));
    formData.append('content', content);
    formData.append('mimeType', 'application/vnd.google-apps.document');
    
    const result = await this.fetch<{ id: string }>(
      'https://www.googleapis.com/upload/drive/v3/files',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: formData,
      }
    );
    
    return result.id;
  }
  
  async documentExists(docId: string): Promise<boolean> {
    try {
      await this.fetch(`${this.driveUrl}/files/${docId}`, {
        method: 'GET',
      });
      return true;
    } catch {
      return false;
    }
  }
  
  async getDocumentPermissions(docId: string): Promise<string[]> {
    const result = await this.fetch<{ permissions: { type: string }[] }>(
      `${this.driveUrl}/files/${docId}/permissions`,
      { method: 'GET' }
    );
    
    return result.permissions.map(p => p.type);
  }
}

/** Factory function để create service */
export function createGoogleDocsService(accessToken?: string): GoogleDocsService {
  if (accessToken) {
    return new RealGoogleDocsService(accessToken);
  }
  return new MockGoogleDocsService();
}

/** Placeholder replacer cho Google Docs content */
export interface PlaceholderReplacement {
  placeholder: string;
  value: string;
}

/**
 * Replace placeholders in Google Docs content
 * Xử lý đặc biệt cho tables và formatting
 */
export function replacePlaceholdersInContent(
  content: string,
  replacements: PlaceholderReplacement[]
): string {
  const replacementMap: Record<string, string> = {};
  
  for (const r of replacements) {
    replacementMap[r.placeholder] = r.value;
  }
  
  return replaceMultiplePlaceholders(content, replacementMap);
}

/**
 * Create page break text
 */
export const PAGE_BREAK_TEXT = '\n\n---\n\n--- PAGE BREAK ---\n\n---\n\n';

/**
 * Merge multiple records into one document
 */
export function mergeRecordsToDocument(
  baseContent: string,
  recordContents: string[]
): string {
  return recordContents.join(PAGE_BREAK_TEXT);
}
