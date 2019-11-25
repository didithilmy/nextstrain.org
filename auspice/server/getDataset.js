const queryString = require("query-string");
const utils = require("./utils");
const helpers = require("./getDatasetHelpers");
const {NoDatasetPathError} = require("./exceptions");
const auspice = require("auspice");
const request = require('request');

/**
 *
 * @param {*} res
 * @param {*} datasetInfo
 * @param {*} query
 */
const requestCertainFileType = async (res, req, additional, query) => {
  const jsonData = await utils.fetchJSON(additional);
  if (query.type === "tree") {
    res.json({tree: jsonData});
  }
  res.json(jsonData);
};


const requestV1Dataset = async (res, metaJsonUrl, treeJsonUrl) => {
  utils.verbose(`Trying to request v1 datasets at: "${metaJsonUrl}" & "${treeJsonUrl}`);
  let data, datasetJson;
  try {
    data = await Promise.all([utils.fetchJSON(metaJsonUrl), utils.fetchJSON(treeJsonUrl)]);
  } catch (err) {
    utils.warn("Failed to fetch v1 dataset JSONs");
    return res.sendStatus(404); // Not Found
  }
  try {
    datasetJson = auspice.convertFromV1({tree: data[1], meta: data[0]});
  } catch (err) {
    utils.warn("Failed to convert v1 dataset JSONs to v2");
    return res.sendStatus(500); // Internal Server Error
  }
  utils.verbose(`Success fetching & converting v1 auspice JSONs. Sending as a single v2 JSON.`);
  return res.send(datasetJson);
};

/**
 * The "main" dataset is assumed to be a v2+ (unified) JSON
 * If this request 404s, then we attempt to fetch a v1-version
 * of the dataset (i.e. meta + tree JSONs) and convert it
 * to v2 format for the response.
 */
const requestMainDataset = async (res, fetchUrls) => {
  /* try to stream the (v2+) dataset JSON as the response */
  const req = request
    .get(fetchUrls.main)
    .on("response", (response) => {
      if (response.statusCode === 200) {
        utils.verbose(`Successfully streaming ${fetchUrls.main}.`);
        req.pipe(res);
      } else {
        utils.verbose(`The request for ${fetchUrls.main} returned ${response.statusCode}.`);
        requestV1Dataset(res, fetchUrls.meta, fetchUrls.tree);
      }
    });
};

/**
 * Uses custom logic to match a "best guess" dataset from the client's *req* to
 * a dataset stored on nextstrain.org.
 *
 * If the request URL differs from the URL of the matched dataset, then it sends
 * the client a redirect to the new URL.
 *
 * If the URLs match, then it sends the client the requested dataset as a JSON
 * object.
 *
 * @param {Request} req
 * @param {Response} res
 */
const getDataset = async (req, res) => {
  const query = queryString.parse(req.url.split('?')[1]);
  if (!query.prefix) {
    return helpers.handleError(res, `getDataset request must define a prefix`);
  }
  utils.log(`Getting (nextstrain) datasets for: ${req.url.split('?')[1]}`);

  // construct fetch URL
  let datasetInfo;
  try {
    datasetInfo = helpers.parsePrefix(query.prefix, query);
    utils.verbose("Dataset: ", datasetInfo);
  } catch (err) {
    /* Return a 204 No Content when Auspice makes a dataset request to a
     * valid source root without a dataset path.
     *
     * Note that this leaks the existence of private sources, but I think
     * broader discussions are leaning towards that anyhow.
     */
    if (err instanceof NoDatasetPathError) {
      utils.verbose(err.message);
      return res.status(204).end();
    }
    return helpers.handleError(res, `Couldn't parse the url "${query.prefix}"`, err.message);
  }

  const {source, fetchUrls, auspiceDisplayUrl} = datasetInfo;

  // Authorization
  if (!source.visibleToUser(req.user)) {
    return helpers.unauthorized(req, res);
  }

  const baseUrl = req.url.split(query.prefix)[0];
  let redirectUrl = baseUrl + '/' + auspiceDisplayUrl;
  if (query.type) {
    redirectUrl += `&type=${query.type}`;
  }

  if (redirectUrl !== req.url) {
    utils.log(`Redirecting client to: ${redirectUrl}`);
    res.redirect(redirectUrl);
    return undefined;
  }

  if (fetchUrls.additional) {
    try {
      await requestCertainFileType(res, req, fetchUrls.additional, query);
    } catch (err) {
      return helpers.handleError(res, `Couldn't fetch JSON: ${fetchUrls.additional}`, err.message);
    }
  } else {
    try {
      await requestMainDataset(res, fetchUrls);
    } catch (err) {
      return helpers.handleError(res, `Couldn't fetch JSONs`, err.message);
    }
  }
  return undefined;
};

module.exports = {
  getDataset,
  default: getDataset
};
