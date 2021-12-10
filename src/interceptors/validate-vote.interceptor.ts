import {
  injectable,
  Interceptor,
  InvocationContext,
  InvocationResult,
  Provider,
  service,
  ValueOrPromise,
} from '@loopback/core';
import {AnyObject, repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ReferenceType, MethodType, SectionType} from '../enums';
import {
  CommentRepository,
  VoteRepository,
  PostRepository,
} from '../repositories';
import {MetricService} from '../services';

/**
 * This class will be bound to the application as an `Interceptor` during
 * `boot`
 */
@injectable({tags: {key: ValidateVoteInterceptor.BINDING_KEY}})
export class ValidateVoteInterceptor implements Provider<Interceptor> {
  static readonly BINDING_KEY = `interceptors.${ValidateVoteInterceptor.name}`;

  constructor(
    @repository(CommentRepository)
    protected commentRepository: CommentRepository,
    @repository(VoteRepository)
    protected voteRepository: VoteRepository,
    @repository(PostRepository)
    protected postRepository: PostRepository,
    @service(MetricService)
    protected metricService: MetricService,
  ) {}

  /**
   * This method is used by LoopBack context to produce an interceptor function
   * for the binding.
   *
   * @returns An interceptor function
   */
  value() {
    return this.intercept.bind(this);
  }

  /**
   * The logic to intercept an invocation
   * @param invocationCtx - Invocation context
   * @param next - A function to invoke next interceptor or the target method
   */
  async intercept(
    invocationCtx: InvocationContext,
    next: () => ValueOrPromise<InvocationResult>,
  ) {
    const methodName = invocationCtx.methodName as MethodType;
    const {type, referenceId, toUserId} = await this.beforeVote(
      methodName,
      invocationCtx,
    );

    const result = await next();

    await this.afterVote(type, referenceId, toUserId);

    if (methodName === MethodType.CREATEVOTE) {
      const popularCount = await this.metricService.countPopularPost(
        result.value.postId,
      );

      await this.postRepository.updateById(result.value.postId, {
        popularCount: popularCount,
      });

      return Object.assign(result.value, {
        id: result.value._id,
        _id: undefined,
      });
    }

    return result;
  }

  async beforeVote(
    methodName: MethodType,
    invocationCtx: InvocationContext,
  ): Promise<AnyObject> {
    if (methodName === MethodType.DELETEBYID) {
      const vote = await this.voteRepository.findById(invocationCtx.args[0]);

      return {
        referenceId: vote.referenceId,
        toUserId: vote.toUserId,
        type: vote.type,
      };
    }

    const {userId, referenceId, type, state, section, postId} =
      invocationCtx.args[0];

    const {createdBy} = await this.postRepository.findById(postId);
    invocationCtx.args[0].toUserId = createdBy;

    if (type === ReferenceType.POST) invocationCtx.args[0].section = undefined;
    if (type === ReferenceType.COMMENT && !section)
      throw new HttpErrors.UnprocessableEntity(
        'Section cannot empty when you upvote/downvote comment',
      );

    if (state === false) {
      switch (type) {
        case ReferenceType.POST: {
          const postComment = await this.commentRepository.findOne({
            where: {userId, referenceId, type, section: SectionType.DEBATE},
          });
          if (postComment) break;
          throw new HttpErrors.UnprocessableEntity(
            'Please comment first in debate sections, before you downvote this post',
          );
        }
      }
    }

    return {
      referenceId: referenceId,
      toUserId: createdBy,
      type: type,
    };
  }

  async afterVote(
    type: ReferenceType,
    referenceId: string,
    toUserId: string,
  ): Promise<void> {
    const metric = await this.metricService.publicMetric(type, referenceId);

    await this.metricService.userMetric(toUserId);

    switch (type) {
      case ReferenceType.POST: {
        const post = await this.postRepository.findOne({
          where: {id: referenceId},
        });
        if (!post) return;

        return this.postRepository.updateById(referenceId, {
          metric: Object.assign(post.metric, metric),
        });
      }

      case ReferenceType.COMMENT:
        return this.commentRepository.updateById(referenceId, {
          metric: metric,
        });

      default:
        return;
    }
  }
}
