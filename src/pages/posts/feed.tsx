import { Button, Group, Stack, useMantineTheme } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconChevronLeft } from '@tabler/icons-react';
import { Announcements } from '~/components/Announcements/Announcements';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { constants } from '~/server/common/constants';
import { containerQuery } from '~/utils/mantine-css-helpers';

export default function PostFeed() {
  const { query } = usePostQueryParams();
  const theme = useMantineTheme();

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.image}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer>
        <Stack spacing="xs">
          <Announcements
            sx={(theme) => ({
              marginBottom: -35,
              [containerQuery.smallerThan('md')]: {
                marginBottom: -5,
              },
            })}
          />
          <HomeContentToggle sx={showMobile} />
          <Group position="apart" spacing={0}>
            <Group>
              <HomeContentToggle sx={hideMobile} />
              <SortFilter type="posts" />
            </Group>
            <Group spacing={4}>
              <PeriodFilter type="posts" />
            </Group>
          </Group>
          <Group>
            <Button
              component={NextLink}
              href="/posts"
              variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
              color="gray"
              pl={2}
              compact
            >
              <Group spacing={4}>
                <IconChevronLeft />
                Back to Categories
              </Group>
            </Button>
          </Group>
          <PostsInfinite filters={query} />
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
