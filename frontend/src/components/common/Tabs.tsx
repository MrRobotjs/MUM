import { ReactNode, useState } from 'react';
import { cn } from '@/lib/utils';

export type Tab = {
  id: string;
  label: string | ReactNode;
  content: ReactNode;
  disabled?: boolean;
  badge?: string | number;
};

export type TabsProps = {
  tabs: Tab[];
  defaultTab?: string;
  activeTab?: string;
  onChange?: (tabId: string) => void;
  variant?: 'bordered' | 'lifted' | 'boxed';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
};

export const Tabs = ({
  tabs,
  defaultTab,
  activeTab: controlledActiveTab,
  onChange,
  variant = 'bordered',
  size = 'md',
  className,
}: TabsProps) => {
  const [internalActiveTab, setInternalActiveTab] = useState(
    defaultTab || tabs[0]?.id || ''
  );

  const activeTab = controlledActiveTab ?? internalActiveTab;
  const isControlled = controlledActiveTab !== undefined;

  const handleTabClick = (tabId: string) => {
    if (!isControlled) {
      setInternalActiveTab(tabId);
    }
    onChange?.(tabId);
  };

  const activeTabData = tabs.find((tab) => tab.id === activeTab);

  const tabsClasses = cn(
    'tabs',
    {
      'tabs-bordered': variant === 'bordered',
      'tabs-lifted': variant === 'lifted',
      'tabs-boxed': variant === 'boxed',
      'tabs-xs': size === 'xs',
      'tabs-sm': size === 'sm',
      'tabs-md': size === 'md',
      'tabs-lg': size === 'lg',
    },
    className
  );

  return (
    <div className="w-full">
      <div role="tablist" className={tabsClasses}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            className={cn('tab', {
              'tab-active': activeTab === tab.id,
              'tab-disabled': tab.disabled,
            })}
            onClick={() => !tab.disabled && handleTabClick(tab.id)}
            disabled={tab.disabled}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="badge badge-sm ml-2">{tab.badge}</span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-4">{activeTabData?.content}</div>
    </div>
  );
};
