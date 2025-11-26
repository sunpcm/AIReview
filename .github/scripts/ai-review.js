// .github/scripts/ai-review.js
const { OpenAI } = require("openai");
const github = require("@actions/github");
const parseDiff = require("parse-diff");

// 1. 初始化
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL;

const octokit = github.getOctokit(GITHUB_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: API_BASE_URL });

const context = github.context;
const { owner, repo } = context.repo;
const pull_number = context.payload.pull_request.number;

// 2. 核心函数：获取 Diff 并调用 AI
async function run() {
	console.log(`🚀 开始 Review PR #${pull_number}`);
	
	// 获取 PR 修改的所有文件
	const { data: files } = await octokit.rest.pulls.listFiles({
		owner,
		repo,
		pull_number,
	});
	
	for (const file of files) {
		// 过滤：只看 JS/TS/Vue/React 文件，忽略删除的文件和 lock 文件
		if (
			file.status === "removed" ||
			file.filename.includes("lock") ||
			!file.filename.match(/\.(js|jsx|ts|tsx|vue)$/)
		) {
			continue;
		}
		
		console.log(`正在分析文件: ${file.filename}...`);
		
		// 获取 Patch (Git Diff 片段)
		const patch = file.patch;
		if (!patch) continue;
		
		// 简单防爆：如果 Patch 太长（比如超过 2000 字符），跳过以省钱/防报错
		if (patch.length > 2000) {
			console.log(`⚠️ 文件 ${file.filename} 变动太大，跳过 AI 分析。`);
			continue;
		}
		
		// 3. 构造 Prompt
		const prompt = `
      你是资深前端架构师。请Review下面的代码变动 (Git Diff)。
      文件路径: ${file.filename}
      
      要求：
      1. 找出潜在的 Bug、安全漏洞、性能问题。
      2. 忽略代码格式、缩进、注释问题。
      3. 如果代码看起来没问题，输出空数组。
      4. 必须以 JSON 格式返回，根对象包含一个 "reviews" 数组，格式如下：
      {
        "reviews": [
          { "lineNumber": <diff中的目标行号>, "comment": "<你的建议>" }
        ]
      }
      
      代码 Diff:
      ${patch}
    `;
		
		// 4. 调用 OpenAI
		try {
			const response = await openai.chat.completions.create({
				model: "gemini-2.5-flash", // 使用 mini 模型比较便宜，效果够用
				messages: [{ role: "user", content: prompt }],
				max_tokens: 500,
			});
			
			// 🔍 DEBUG: 打印原始返回，以此排查是否被安全策略拦截
			console.log(`DEBUG [${file.filename}]:`, JSON.stringify(response.choices[0], null, 2));
			
			let content = response.choices[0].message.content;
			
			// 🛡️ 防御 1: 如果内容为空（可能被安全拦截）
			if (!content) {
				console.log(`⚠️ ${file.filename} API返回内容为空 (可能触发了 Safety Filter)`);
				continue;
			}
			
			// 🛡️ 防御 2: 清洗 Gemini 喜欢加的 Markdown 标记 (```json ... ```)
			// 这一步非常关键！Gemini 几乎 100% 会带这个
			content = content.replace(/```json/g, '').replace(/```/g, '').trim();
			
			const result = JSON.parse(content);
			const reviews = Array.isArray(result) ? result : (result.reviews || []);
			
			if (reviews.length === 0) {
				console.log(`✅ ${file.filename} 无建议。`);
				continue;
			}
			
			// 5. 提交评论到 GitHub
			await postComments(file, reviews);
			
		} catch (error) {
			// 打印 content 里的具体报错位置，方便调试
			console.error(`❌ 分析 ${file.filename} 失败:`, error.message);
			if (error instanceof SyntaxError) {
				console.error("解析失败的原始内容:", response?.choices[0]?.message?.content);
			}
		}
	}
}

// 辅助函数：将 AI 的评论挂载到 GitHub
async function postComments(file, reviews) {
	// 解析 Diff 以定位准确的行号
	// parse-diff 会把 patch 拆分成 chunks -> changes
	const diffData = parseDiff(file.patch)[0];
	
	for (const review of reviews) {
		// 我们需要找到 lineNumber 在 diff 中对应的 position（这是 GitHub API 的坑点）
		// 简单起见，这里我们尝试匹配 patch 中的行。
		// 如果想要完美的行号匹配，逻辑会比较复杂，这里做一个简化版的查找：
		// AI 返回的 lineNumber 应该是新文件中的行号。
		
		// *注意*：GitHub Create Review Comment API 需要的是 'line' (新文件的行号)
		// 只有在 diff 上下文里的行才能被评论。
		
		if (!review.lineNumber || !review.comment) continue;
		
		try {
			await octokit.rest.pulls.createReviewComment({
				owner,
				repo,
				pull_number,
				body: `🤖 **AI Review**: ${review.comment}`,
				commit_id: context.payload.pull_request.head.sha, // 必须指定 commit
				path: file.filename,
				line: Number(review.lineNumber), // 对应新文件的行号
				side: 'RIGHT' // 指向修改后的文件
			});
			console.log(`📝 已评论: ${file.filename} : ${review.lineNumber}`);
		} catch (e) {
			// 常见错误：AI 指向的行号不在 Diff 上下文中（即该行没被修改也没被包含在diff里）
			console.log(`⚠️ 无法评论行 ${review.lineNumber} (可能不在 Diff 上下文中)`);
		}
	}
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});