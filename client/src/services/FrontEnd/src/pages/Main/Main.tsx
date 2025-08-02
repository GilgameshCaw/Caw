import { Tabs, TabItem } from '~/components/Tabs'
import MainLayout from "~/layouts/MainLayout";
import PostForm from "~/components/PostForm";
import Feed from "~/components/Feed";
import React, { useState } from "react";

type MainTab = 'following' | 'for-you'

export const Main: React.FC = () => {
  const [activeTab, setActiveTab] = useState<MainTab>('following')

  const mainTabs: TabItem<MainTab>[] = [
    { id: 'following', label: 'Following' },
    { id: 'for-you', label: 'For You' },
  ]

  return (
    <MainLayout>
        <Tabs<MainTab>
          tabs={mainTabs}
          active={activeTab}
          onChange={setActiveTab}
        />
        <div className="border-b border-gray-700">
          <PostForm/>
        </div>
        <Feed
          filter={activeTab}
        />
    </MainLayout>
  );
};
