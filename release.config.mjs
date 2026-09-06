export default {
  branches: [
    {
      name: "main",
    },
    {
      name: "toto04/semantic-releases",
      channel: "beta",
      prerelease: "test",
    },
  ],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/npm",
      {
        npmPublish: true,
        pkgRoot: "./dist",
      },
    ],
    [
      "@semantic-release/github",
      {
        successComment: false,
        failCommentCondition: false,
        addReleases: "top",
      },
    ],
  ],
}
