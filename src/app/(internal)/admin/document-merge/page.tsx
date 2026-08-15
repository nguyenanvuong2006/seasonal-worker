'use client';

/**
 * Document Merge Center — Main Page
 * 
 * Trung tâm hợp nhất để quản lý template và thực hiện merge documents.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';

type TabType = 'templates' | 'merge' | 'history' | 'fields';

const tabs: { id: TabType; label: string; icon: string }[] = [
  { id: 'templates', label: 'Templates', icon: '📄' },
  { id: 'merge', label: 'Merge Documents', icon: '📝' },
  { id: 'history', label: 'Merge History', icon: '📋' },
  { id: 'fields', label: 'Fields & Placeholders', icon: '🔑' },
];

export default function DocumentMergeCenterPage() {
  const [activeTab, setActiveTab] = useState<TabType>('templates');
  
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  Document Merge Center
                </h1>
                <p className="mt-1 text-sm text-gray-500">
                  Generic Document Merge Engine - Tạo Google Docs từ templates
                </p>
              </div>
              {activeTab === 'templates' && (
                <Link
                  href="/admin/document-merge/templates/new"
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                >
                  <span className="mr-2">+</span>
                  Tạo Template mới
                </Link>
              )}
            </div>
          </div>
          
          {/* Tabs */}
          <div className="-mb-px flex space-x-8">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
                  ${
                    activeTab === tab.id
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      
      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'templates' && <TemplatesTab />}
        {activeTab === 'merge' && <MergeTab />}
        {activeTab === 'history' && <HistoryTab />}
        {activeTab === 'fields' && <FieldsTab />}
      </div>
    </div>
  );
}

// Placeholder components - sẽ được thay thế bằng components thực
function TemplatesTab() {
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<any[]>([]);
 
  // Fetch templates
  useEffect(() => {
    fetch('/api/document-merge/templates')
      .then(res => res.json())
      .then(data => {
        setTemplates(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
 
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }
  
  if (templates.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-4">📄</div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          Chưa có template nào
        </h3>
        <p className="text-gray-500 mb-4">
          Bắt đầu bằng cách tạo template đầu tiên của bạn
        </p>
        <Link
          href="/admin/document-merge/templates/new"
          className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
        >
          + Tạo Template đầu tiên
        </Link>
      </div>
    );
  }
  
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {templates.map((template) => (
        <TemplateCard key={template.id} template={template} />
      ))}
    </div>
  );
}

function TemplateCard({ template }: { template: any }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
      <div className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <h3 className="text-lg font-medium text-gray-900 truncate">
              {template.name}
            </h3>
            {template.description && (
              <p className="mt-1 text-sm text-gray-500 line-clamp-2">
                {template.description}
              </p>
            )}
          </div>
          <span
            className={`ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              template.isActive
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-100 text-gray-800'
            }`}
          >
            {template.isActive ? 'ACTIVE' : 'INACTIVE'}
          </span>
        </div>
        
        <div className="space-y-2 text-sm text-gray-500">
          <div className="flex items-center">
            <span className="w-24">Google Docs ID:</span>
            <span className="font-mono text-xs">{template.googleDocId}</span>
          </div>
          <div className="flex items-center">
            <span className="w-24">Placeholders:</span>
            <span className="font-medium">{template.placeholderCount || 0}</span>
          </div>
          <div className="flex items-center">
            <span className="w-24">Data Sources:</span>
            <span>{template.dataSources?.join(', ') || '-'}</span>
          </div>
          <div className="flex items-center">
            <span className="w-24">Cập nhật:</span>
            <span>{template.updatedBy} - {template.updatedAt ? new Date(template.updatedAt).toLocaleDateString('vi-VN') : '-'}</span>
          </div>
        </div>
      </div>
      
      <div className="border-t border-gray-200 px-6 py-3 bg-gray-50 flex items-center justify-between">
        <div className="flex gap-2">
          <Link
            href={`/admin/document-merge/templates/${template.id}`}
            className="text-primary-600 hover:text-primary-800 text-sm font-medium"
          >
            Xem
          </Link>
          <Link
            href={`/admin/document-merge/templates/${template.id}/edit`}
            className="text-gray-600 hover:text-gray-800 text-sm font-medium"
          >
            Sửa
          </Link>
        </div>
        <Link
          href={`/admin/document-merge?template=${template.id}`}
          className="text-sm font-medium text-primary-600 hover:text-primary-800"
        >
          Merge →
        </Link>
      </div>
    </div>
  );
}

function MergeTab() {
  return (
    <div className="text-center py-12">
      <div className="text-4xl mb-4">📝</div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">
        Merge Documents
      </h3>
      <p className="text-gray-500">
        Chọn template và records để thực hiện merge
      </p>
    </div>
  );
}

function HistoryTab() {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<any[]>([]);
 
  useEffect(() => {
    fetch('/api/document-merge/history')
      .then(res => res.json())
      .then(data => {
        setHistory(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
 
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }
  
  if (history.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-4">📋</div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          Chưa có lịch sử merge
        </h3>
        <p className="text-gray-500">
          Các lần merge thực hiện trước đó sẽ hiển thị ở đây
        </p>
      </div>
    );
  }
  
  return (
    <div className="bg-white shadow overflow-hidden sm:rounded-md">
      <ul className="divide-y divide-gray-200">
        {history.map((job) => (
          <li key={job.id}>
            <div className="px-4 py-4 sm:px-6">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-sm font-medium text-primary-600 truncate">
                    {job.templateNameSnapshot}
                  </p>
                  <p className="mt-1 text-sm text-gray-500">
                    {job.recordCount} records • {job.mergeMode}
                  </p>
                </div>
                <div className="ml-2 flex-shrink-0 flex">
                  <span
                    className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                      job.status === 'COMPLETED'
                        ? 'bg-green-100 text-green-800'
                        : job.status === 'FAILED'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {job.status}
                  </span>
                </div>
              </div>
              <div className="mt-2 sm:flex sm:justify-between sm:items-end">
                <div className="sm:flex sm:items-center text-sm text-gray-500">
                  <p>
                    Bởi {job.createdBy} • {new Date(job.createdAt).toLocaleString('vi-VN')}
                  </p>
                </div>
                {job.outputUrl && job.status === 'COMPLETED' && (
                  <div className="mt-2 sm:mt-0 flex gap-2">
                    <a
                      href={job.outputUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-600 hover:text-primary-800 text-sm font-medium"
                    >
                      Mở Google Docs →
                    </a>
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FieldsTab() {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<any>(null);
 
  useEffect(() => {
    fetch('/api/document-merge/field-catalog')
      .then(res => res.json())
      .then(data => {
        setCatalog(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
 
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }
  
  if (!catalog) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Không thể tải field catalog</p>
      </div>
    );
  }
  
  const categoryLabels: Record<string, string> = {
    worker_profile: 'Hồ sơ Tập nghề',
    daily_application: 'Đơn đăng ký',
    employment_session: 'Phiên làm việc',
    department: 'Bộ phận',
    dynamic_form: 'Câu hỏi động',
    computed: 'Trường tính toán',
    system: 'Hệ thống',
  };
  
  return (
    <div className="space-y-8">
      <div className="bg-white shadow overflow-hidden sm:rounded-md">
        <div className="px-4 py-5 sm:px-6 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">
            Field Catalog
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Tổng cộng {catalog.totalFields} fields có thể sử dụng trong merge
          </p>
        </div>
        
        {Object.entries(catalog.groupedCatalog || {}).map(([category, fieldsArr]) => (
          <div key={category} className="border-b border-gray-200 last:border-b-0">
            <div className="px-4 py-3 bg-gray-50">
              <h4 className="text-sm font-medium text-gray-700">
                {categoryLabels[category as string] || category} ({(fieldsArr as any[]).length})
              </h4>
            </div>
            <ul className="divide-y divide-gray-200">
              {(fieldsArr as any[]).map((field: any) => (
                <li key={field.fieldKey} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {field.label}
                      </p>
                      <p className="text-xs text-gray-500 font-mono">
                        {field.databaseSource}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-500">
                        Placeholder: <span className="font-mono">{field.suggestedPlaceholder}</span>
                      </p>
                      <p className="text-xs text-gray-400">
                        Type: {field.fieldType}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
