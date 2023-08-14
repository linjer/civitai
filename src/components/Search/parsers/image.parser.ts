import { UiState } from 'instantsearch.js';
import { z } from 'zod';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';
import { InstantSearchRoutingParser, searchParamsSchema } from './base';

export const ImagesSearchIndexSortBy = [
  'images:rank.reactionCountAllTimeRank:asc',
  'images:rank.commentCountAllTimeRank:asc',
  'images:createdAt:desc',
] as const;

const imageSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('images'),
    sortBy: z.enum(ImagesSearchIndexSortBy),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export type ImageSearchParams = z.output<typeof imageSearchParamsSchema>;

export const imagesInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const articleSearchIndexResult = imageSearchParamsSchema.safeParse(QS.parse(location.search));
    const articleSearchIndexData: ImageSearchParams | Record<string, string[]> =
      articleSearchIndexResult.success ? articleSearchIndexResult.data : {};

    return { images: removeEmpty(articleSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const images: ImageSearchParams = (routeState.images || {}) as ImageSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'tags.name': images.tags,
    });

    const { query, page, sortBy } = images;

    return {
      images: {
        query,
        page,
        sortBy: sortBy ?? 'images:rank.reactionCountAllTimeRank:asc',
        refinementList,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const tags = uiState.images.refinementList?.['tags.name'];
    const sortBy =
      (uiState.images.sortBy as ImageSearchParams['sortBy']) ||
      'images:rank.reactionCountAllTimeRank:asc';

    const { query, page } = uiState.images;

    const state: ImageSearchParams = {
      tags,
      sortBy,
      query,
      page,
    };

    return { images: state };
  },
};
